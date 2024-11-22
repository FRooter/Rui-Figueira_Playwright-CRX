/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { splitProgress } from '@trace-viewer/sw/progress';
import { unwrapPopoutUrl } from '@trace-viewer/sw/snapshotRenderer';
import { SnapshotServer } from '@trace-viewer/sw/snapshotServer';
import { TraceModel } from '@trace-viewer/sw/traceModel';
import { TraceVersionError } from '@trace-viewer/sw/traceModernizer';
import { ExtendedProjectVirtualFs } from '../utils/project';
import { getVirtualFs } from '../utils/virtualFs';
import { CrxFetchTraceModelBackend, CrxZipTraceModelBackend } from './crxTraceModelBackend';

// @ts-ignore
declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', function(event: any) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event: any) {
  event.waitUntil(self.clients.claim());
});

const scopePath = new URL(self.registration.scope).pathname;

const loadedTraces = new Map<string, { traceModel: TraceModel, snapshotServer: SnapshotServer }>();

const clientIdToTraceUrls = new Map<string, { limit: number | undefined, traceUrls: Set<string> }>();

export async function loadTrace(traceUrl: string, traceFileName: string | null, clientId: string, limit: number | undefined, progress: (done: number, total: number) => undefined): Promise<TraceModel> {
  await gc();
  let data = clientIdToTraceUrls.get(clientId);
  if (!data) {
    data = { limit, traceUrls: new Set() };
    clientIdToTraceUrls.set(clientId, data);
  }
  data.traceUrls.add(traceUrl);
  const traceModel = new TraceModel();
  try {
    const virtualFs = await getVirtualFs('ui-mode.project-dir', 'read');
    let blob: Blob | undefined;
    if (!traceUrl.endsWith('json')) {
      blob = await virtualFs?.readFile(traceUrl);
      if (!blob)
        throw new Error(`Could not find trace ${traceUrl} in the project directory.`);
    }
    
    // Allow 10% to hop from sw to page.
    const [fetchProgress, unzipProgress] = splitProgress(progress, [0.5, 0.4, 0.1]);
    const backend = blob ? new CrxZipTraceModelBackend(traceUrl, blob, fetchProgress) : new CrxFetchTraceModelBackend(traceUrl);
    await traceModel.load(backend, unzipProgress);
  } catch (error: any) {
    // eslint-disable-next-line no-console
    console.error(error);
    if (error?.message?.includes('Cannot find .trace file') && await traceModel.hasEntry('index.html'))
      throw new Error('Could not load trace. Did you upload a Playwright HTML report instead? Make sure to extract the archive first and then double-click the index.html file or put it on a web server.');
    if (error instanceof TraceVersionError)
      throw new Error(`Could not load trace from ${traceFileName || traceUrl}. ${error.message}`);
    if (traceFileName)
      throw new Error(`Could not load trace from ${traceFileName}. Make sure to upload a valid Playwright trace.`);
    throw new Error(`Could not load trace from ${traceUrl}. Make sure a valid Playwright Trace is accessible over this url.`);
  }
  const snapshotServer = new SnapshotServer(traceModel.storage(), sha1 => traceModel.resourceForSha1(sha1));
  loadedTraces.set(traceUrl, { traceModel, snapshotServer });
  return traceModel;
}

// @ts-ignore
async function doFetch(event: FetchEvent): Promise<Response> {
  // In order to make Accessibility Insights for Web work.
  if (event.request.url.startsWith('chrome-extension://') && !event.request.url.startsWith(`chrome-extension://${chrome.runtime.id}`))
    return fetch(event.request);

  const request = event.request;
  const client = await self.clients.get(event.clientId);

  // When trace viewer is deployed over https, we will force upgrade
  // insecure http subresources to https. Otherwise, these will fail
  // to load inside our https snapshots.
  // In this case, we also match http resources from the archive by
  // the https urls.
  const isDeployedAsHttps = self.registration.scope.startsWith('https://');

  if (request.url.startsWith(self.registration.scope)) {
    const url = new URL(unwrapPopoutUrl(request.url));
    const relativePath = url.pathname.substring(scopePath.length - 1);
    if (relativePath === '/ping') {
      await gc();
      return new Response(null, { status: 200 });
    }

    const traceUrl = url.searchParams.get('trace');

    if (relativePath === '/contexts') {
      try {
        const limit = url.searchParams.has('limit') ? +url.searchParams.get('limit')! : undefined;
        const traceModel = await loadTrace(traceUrl!, url.searchParams.get('traceFileName'), event.clientId, limit, (done: number, total: number) => {
          client.postMessage({ method: 'progress', params: { done, total } });
        });
        return new Response(JSON.stringify(traceModel!.contextEntries), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error?.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (relativePath.startsWith('/snapshotInfo/')) {
      const { snapshotServer } = loadedTraces.get(traceUrl!) || {};
      if (!snapshotServer)
        return new Response(null, { status: 404 });
      return snapshotServer.serveSnapshotInfo(relativePath, url.searchParams);
    }

    if (relativePath.startsWith('/snapshot/')) {
      const { snapshotServer } = loadedTraces.get(traceUrl!) || {};
      if (!snapshotServer)
        return new Response(null, { status: 404 });
      const response = snapshotServer.serveSnapshot(relativePath, url.searchParams, url.href);
      if (isDeployedAsHttps)
        response.headers.set('Content-Security-Policy', 'upgrade-insecure-requests');
      return response;
    }

    if (relativePath.startsWith('/closest-screenshot/')) {
      const { snapshotServer } = loadedTraces.get(traceUrl!) || {};
      if (!snapshotServer)
        return new Response(null, { status: 404 });
      return snapshotServer.serveClosestScreenshot(relativePath, url.searchParams);
    }

    if (relativePath.startsWith('/sha1/')) {
      // Sha1 for sources is based on the file path, can't load it of a random model.
      const sha1 = relativePath.slice('/sha1/'.length);
      for (const trace of loadedTraces.values()) {
        const blob = await trace.traceModel.resourceForSha1(sha1);
        if (blob)
          return new Response(blob, { status: 200, headers: downloadHeaders(url.searchParams) });
      }
      return new Response(null, { status: 404 });
    }

    if (relativePath === '/file') {
      try {
        const virtualFs = await getVirtualFs('ui-mode.project-dir', 'read');
        if (virtualFs) {
          const projectVirtualFs = new ExtendedProjectVirtualFs(virtualFs);
          const body = await projectVirtualFs.readFile(url.searchParams.get('path')!);
          return new Response(body, { status: 200, headers: downloadHeaders(url.searchParams) });
        }
      } catch (e) {
        // oh well
      }

      return new Response(null, { status: 404 });
    }

    // Fallback to network.
    return fetch(event.request);
  }

  const snapshotUrl = unwrapPopoutUrl(client!.url);
  const traceUrl = new URL(snapshotUrl).searchParams.get('trace')!;
  const { snapshotServer } = loadedTraces.get(traceUrl) || {};
  if (!snapshotServer)
    return new Response(null, { status: 404 });

  const lookupUrls = [request.url];
  if (isDeployedAsHttps && request.url.startsWith('https://'))
    lookupUrls.push(request.url.replace(/^https/, 'http'));
  return snapshotServer.serveResource(lookupUrls, request.method, snapshotUrl);
}

function downloadHeaders(searchParams: URLSearchParams): Headers | undefined {
  const name = searchParams.get('dn');
  const contentType = searchParams.get('dct');
  if (!name)
    return;
  const headers = new Headers();
  headers.set('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (contentType)
    headers.set('Content-Type', contentType);
  return headers;
}

async function gc() {
  const clients = await self.clients.matchAll();
  const usedTraces = new Set<string>();

  for (const [clientId, data] of clientIdToTraceUrls) {
    // @ts-ignore
    if (!clients.find(c => c.id === clientId)) {
      clientIdToTraceUrls.delete(clientId);
      continue;
    }
    if (data.limit !== undefined) {
      const ordered = [...data.traceUrls];
      // Leave the newest requested traces.
      data.traceUrls = new Set(ordered.slice(ordered.length - data.limit));
    }
    data.traceUrls.forEach(url => usedTraces.add(url));
  }

  for (const traceUrl of loadedTraces.keys()) {
    if (!usedTraces.has(traceUrl))
      loadedTraces.delete(traceUrl);
  }
}

// @ts-ignore
self.addEventListener('fetch', function(event: FetchEvent) {
  event.respondWith(doFetch(event));
});
