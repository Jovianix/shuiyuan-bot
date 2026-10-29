// The MCP child's only network path; the child runs without model credentials in its environment.
// Requests go one at a time to PET_SITE, PET_HTTP_GAP_MS after the previous response finished.
// Only with PET_ALLOW_WRITES=true may it POST, and only to /posts.json.
//
// Uploads live on separate storage. A GET under /uploads/ or /secure-uploads/ is answered
// with a redirect, and only the host that redirect names may be fetched — never a host the
// caller chose, so post content cannot steer the child at an arbitrary address.
import { setTimeout as delay } from 'node:timers/promises';
const origin = process.env.PET_SITE;
const gap = Number(process.env.PET_HTTP_GAP_MS);
if (!origin || !Number.isSafeInteger(gap) || gap <= 0) throw new Error('Missing MCP network policy');
const site = new URL(origin);
const fetchOriginal = globalThis.fetch;
let tail = Promise.resolve(), finished = 0, requests = 0;
// Hosts the forum itself pointed an upload redirect at, and when that pointer expires.
const uploadHosts = new Map();
const UPLOAD_TTL_MS = 5 * 60_000;
const isUploadPath = path => path.startsWith('/uploads/') || path.startsWith('/secure-uploads/');
function uploadHostAllowed(host) {
  const expires = uploadHosts.get(host);
  return expires !== undefined && expires > Date.now();
}
globalThis.fetch = (input, init = {}) => {
  const operation = tail.then(async () => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const allowedWrite = process.env.PET_ALLOW_WRITES === 'true' && method === 'POST' && url.pathname === '/posts.json';
    const allowedUpload = method === 'GET' && url.protocol === 'https:' && uploadHostAllowed(url.host);
    if (method !== 'GET' && !allowedWrite) throw new Error('MCP request denied by Pet policy');
    if (url.origin !== origin && !allowedUpload) throw new Error('MCP request denied by Pet policy');
    // A redirect is never followed implicitly: the target is recorded, then fetched
    // explicitly, so the second hop is judged by the same policy as the first.
    const redirect = allowedUpload ? 'error' : isUploadPath(url.pathname) && url.origin === origin ? 'manual' : 'error';
    await delay(Math.max(0, finished + gap - Date.now()));
    requests++;
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
    try {
      const response = await fetchOriginal(input, {...init, signal, redirect});
      if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.clone().arrayBuffer();
        if (location) {
          const target = new URL(location, url);
          if (target.protocol === 'https:' && target.host !== site.host) {
            uploadHosts.set(target.host, Date.now() + UPLOAD_TTL_MS);
          }
        }
        return response;
      }
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
