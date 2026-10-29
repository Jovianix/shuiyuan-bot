// Does a User API Key unlock a Discourse secure-upload URL?
// Manual redirects, its own 5s pacing, status lines only. Nothing is written to disk.
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync('secrets/discourse-profile.json', 'utf8'));
const pair = profile.auth_pairs[0];
const site = new URL(pair.site).origin;
const key = pair.user_api_key, client = pair.user_api_client_id;

const real = '/secure-uploads/original/4X/c/2/2/c22135fc5f9f00a2b7585d3dc0b01b01ad32dae4.jpeg';
const short = '/uploads/short-url/rHlMyPmcgbhuVVJsmM4r6sFxL0w.jpeg';

async function probe(label, path, headers) {
  await new Promise(r => setTimeout(r, 5000));
  try {
    const r = await fetch(site + path, {headers: {...headers, Accept: 'image/*'}, redirect: 'manual'});
    const type = r.headers.get('content-type') ?? '';
    const bytes = type.startsWith('image/') ? (await r.arrayBuffer()).byteLength : null;
    if (bytes === null) await r.arrayBuffer();
    console.log(JSON.stringify({label, status: r.status, type, location: r.headers.get('location') ?? null, bytes}));
    return r;
  } catch (e) { console.log(JSON.stringify({label, error: String(e.message)})); }
}

await probe('short, anonymous', short, {});
await probe('short, user-api-key', short, {'User-Api-Key': key, 'User-Api-Client-Id': client});
await probe('secure, anonymous', real, {});
await probe('secure, user-api-key', real, {'User-Api-Key': key, 'User-Api-Client-Id': client});
