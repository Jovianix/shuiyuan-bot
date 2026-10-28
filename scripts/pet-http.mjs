// The MCP child's only network path; the child runs without model credentials in its environment.
// Requests go one at a time to PET_SITE, PET_HTTP_GAP_MS after the previous response finished.
// Only with PET_ALLOW_WRITES=true may it POST, and only to /posts.json. Redirects are refused.
import { setTimeout as delay } from 'node:timers/promises';
const origin = process.env.PET_SITE;
const gap = Number(process.env.PET_HTTP_GAP_MS);
if (!origin || !Number.isSafeInteger(gap) || gap <= 0) throw new Error('Missing MCP network policy');
const fetchOriginal = globalThis.fetch;
let tail = Promise.resolve(), finished = 0, requests = 0;
globalThis.fetch = (input, init = {}) => {
  const operation = tail.then(async () => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const allowedWrite = process.env.PET_ALLOW_WRITES === 'true' && method === 'POST' && url.pathname === '/posts.json';
    if (url.origin !== origin || (method !== 'GET' && !allowedWrite)) throw new Error('MCP request denied by Pet policy');
    await delay(Math.max(0, finished + gap - Date.now()));
    requests++;
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
    try {
      const response = await fetchOriginal(input, {...init, signal, redirect: 'error'});
      await response.clone().arrayBuffer();
      return response;
    } finally { finished = Date.now(); }
  });
  tail = operation.catch(() => {});
  return operation;
};
if (process.env.PET_HTTP_REPORT) {
  process.on('exit', () => process.stderr.write(JSON.stringify({check: 'HTTP pacing', requests, gap_ms: gap}) + '\n'));
}
