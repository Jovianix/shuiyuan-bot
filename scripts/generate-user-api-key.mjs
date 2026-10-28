#!/usr/bin/env node
// Node.js 24+. Authorize once with the exported _t cookie, then reuse the saved key.
import { constants, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const site = 'https://shuiyuan.sjtu.edu.cn';
const root = new URL('../', import.meta.url);
// Kept with the other runtime secrets; the directory is excluded from git and the image build.
const secretsDir = new URL('secrets/', root);
const profilePath = new URL('discourse-profile.json', secretsDir);
const pendingPath = new URL('.user-api-key-pending.json', secretsDir);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function saveNewSecret(path, value) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}

function createClient(initialCookies = {}, apiHeaders = {}) {
  const cookies = new Map(Object.entries(initialCookies));
  return async function request(path, { method = 'GET', form } = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'ShuiyuanBot-KeySetup/1.0',
      ...apiHeaders,
    };
    if (cookies.size) {
      headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin = site;
      headers['X-CSRF-Token'] = form.get('authenticity_token');
    }
    const response = await fetch(new URL(path, site), {
      method,
      headers,
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`${method} ${path.split('?')[0]}: expected JSON`);
    }
    return response.json();
  };
}

async function verifyKey(profile) {
  const auth = profile.auth_pairs?.find(pair => pair.site === site);
  if (!auth?.user_api_key || !auth.user_api_client_id) {
    throw new Error('Saved profile is missing the Shuiyuan API key or client ID.');
  }
  // This client has no browser cookies: success verifies independent API-key auth.
  const request = createClient({}, {
    'User-Api-Key': auth.user_api_key,
    'User-Api-Client-Id': auth.user_api_client_id,
  });
  const session = await request('/session/current.json');
  if (!Number.isInteger(session.current_user?.id)) throw new Error('API key did not authenticate a user.');
  const latest = await request('/latest.json');
  if (!Array.isArray(latest.topic_list?.topics)) throw new Error('Unexpected topic-list response.');
  console.log(JSON.stringify({
    verified: true,
    authentication: 'User-Api-Key only (no cookie)',
    topics_returned: latest.topic_list.topics.length,
    profile: fileURLToPath(profilePath),
  }, null, 2));
}

async function main() {
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  if (await exists(profilePath)) {
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    await chmod(profilePath, 0o600);
    console.log('Existing profile found; verifying the saved key without creating another.');
    await verifyKey(profile);
    return;
  }
  if (await exists(pendingPath)) {
    throw new Error('An earlier authorization may have been submitted. Inspect the local pending file before trying again.');
  }
  const cookie = process.env._t;
  if (!cookie || /[\r\n;]/.test(cookie)) {
    console.error('Missing or invalid _t environment variable. Export _t before running this script.');
    process.exitCode = 1;
    return;
  }
  const request = createClient({ _t: cookie });
  const session = await request('/session/current.json');
  if (!Number.isInteger(session.current_user?.id)) throw new Error('The cookie did not authenticate a user.');
  const csrf = await request('/session/csrf.json');
  if (typeof csrf.csrf !== 'string' || !csrf.csrf) throw new Error('Missing CSRF token.');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // A fresh ID avoids replacing any authorization the user already created elsewhere.
  // The saved profile preserves this ID for all subsequent API calls.
  const clientId = `shuiyuan-bot-${randomUUID()}`;
  const nonce = randomBytes(32).toString('base64url');
  const params = {
    application_name: 'Shuiyuan Bot', client_id: clientId,
    scopes: 'read,write', public_key: publicKey, nonce, padding: 'oaep',
  };
  // Preserve recovery material before the single, non-retried credential-creation request.
  await saveNewSecret(pendingPath, { site, params, private_key: privateKey });
  console.log('Authorizing Shuiyuan Bot with read,write scopes using the supplied cookie.');
  const result = await request('/user-api-key', {
    method: 'POST',
    form: new URLSearchParams({ ...params, authenticity_token: csrf.csrf }),
  });
  // Save the encrypted result too, so a local interruption cannot lose a returned key.
  const pending = await open(pendingPath, 'r+');
  try {
    const state = JSON.stringify({ site, params, private_key: privateKey, response: result }, null, 2) + '\n';
    await pending.writeFile(state);
    await pending.truncate(Buffer.byteLength(state));
    await pending.sync();
  } finally {
    await pending.close();
  }
  if (typeof result.payload !== 'string' || !result.payload) throw new Error('Authorization returned no encrypted payload.');
  const decrypted = privateDecrypt({
    key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1',
  }, Buffer.from(result.payload, 'base64'));
  const payload = JSON.parse(decrypted.toString('utf8'));
  if (payload.nonce !== nonce || typeof payload.key !== 'string' || !payload.key) {
    throw new Error('Authorization payload failed key/nonce validation.');
  }
  const profile = {
    site,
    auth_pairs: [{ site, user_api_key: payload.key, user_api_client_id: clientId }],
    tools_mode: 'discourse_api_only',
    allow_writes: false,
  };
  await saveNewSecret(profilePath, profile);
  await unlink(pendingPath);
  console.log('API key saved with owner-only file permissions. Verifying read access.');
  await verifyKey(profile);
}

main().catch(error => {
  // Do not print response bodies, credentials, or authorization query parameters.
  console.error(`Key setup failed (${error.name}); no automatic retry was performed.`);
  if (error.message.startsWith('GET /') || error.message.startsWith('POST /')) {
    console.error(error.message);
  }
  console.error('Existing credentials are preserved. Check the saved profile or pending authorization file before rerunning.');
  process.exitCode = 1;
});
