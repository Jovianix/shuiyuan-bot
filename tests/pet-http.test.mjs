// The MCP child's network policy, exercised in a child process because the preload
// replaces globalThis.fetch for the whole process at import time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const policy = fileURLToPath(new URL('../scripts/pet-http.mjs', import.meta.url));

/** Run `body` after the policy is loaded over a stub fetch that records every call. */
function run(body, env = {}) {
  const script = `
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({url, method: init.method ?? 'GET', redirect: init.redirect, at: Date.now()});
      const route = globalThis.route?.(new URL(url)) ?? {status: 200};
      // As real fetch does: redirect 'error' refuses any 3xx instead of returning it.
      if (init.redirect === 'error' && route.status >= 300 && route.status < 400) throw new TypeError('fetch failed: redirect');
      return new Response(route.body ?? null, {status: route.status, headers: route.headers ?? {}});
    };
    await import(${JSON.stringify(policy)});
    const attempt = async (url, init) => {
      try { const r = await fetch(url, init); return r.status; } catch (e) { return 'denied: ' + e.message; }
    };
    ${body}
    process.stdout.write(JSON.stringify({results, calls}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {PATH: process.env.PATH, PET_SITE: 'https://forum.invalid', PET_HTTP_GAP_MS: '1', ...env},
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('only the configured site is reachable, and only with GET', () => {
  const {results, calls} = run(`
    const results = [
      await attempt('https://forum.invalid/t/1.json'),
      await attempt('https://elsewhere.invalid/x.png'),
      await attempt('https://forum.invalid/posts.json', {method: 'POST'}),
    ];`);
  assert.equal(results[0], 200);
  assert.match(results[1], /denied/);
  assert.match(results[2], /denied/);
  assert.deepEqual(calls.map(c => c.url), ['https://forum.invalid/t/1.json']);
});

test('an upload redirect opens exactly the storage host the forum named, and nothing else', () => {
  const {results, calls} = run(`
    globalThis.route = url => url.host === 'forum.invalid' && url.pathname.startsWith('/uploads/')
      ? {status: 302, headers: {location: 'https://storage.invalid/original/a.png?sig=1'}}
      : {status: 200};
    const results = [
      // Not named by any redirect yet.
      await attempt('https://storage.invalid/original/a.png'),
      // The site answers an upload path with a redirect, which is returned, not followed.
      await attempt('https://forum.invalid/uploads/short-url/a.png'),
      // Now the named host is readable over HTTPS GET...
      await attempt('https://storage.invalid/original/a.png?sig=1'),
      // ...but not with another method, and no other host was opened.
      await attempt('https://storage.invalid/original/a.png', {method: 'POST'}),
      await attempt('https://other-storage.invalid/a.png'),
    ];`);
  assert.match(results[0], /denied/);
  assert.equal(results[1], 302);
  assert.equal(results[2], 200);
  assert.match(results[3], /denied/);
  assert.match(results[4], /denied/);
  // The site hop is manual so the redirect is judged; the storage hop refuses further redirects.
  assert.deepEqual(calls.map(c => [c.url, c.redirect]), [
    ['https://forum.invalid/uploads/short-url/a.png', 'manual'],
    ['https://storage.invalid/original/a.png?sig=1', 'error'],
  ]);
});

test('a redirect outside the upload paths, or to plain HTTP, opens nothing', () => {
  const {results} = run(`
    globalThis.route = url => url.host === 'forum.invalid'
      ? {status: 302, headers: {location: url.pathname.startsWith('/uploads/')
          ? 'http://insecure.invalid/a.png' : 'https://storage.invalid/a.png'}}
      : {status: 200};
    const results = [
      // Ordinary site requests never follow redirects at all.
      await attempt('https://forum.invalid/t/1.json'),
      await attempt('https://storage.invalid/a.png'),
      // An upload redirect to plain HTTP is not recorded as a readable host.
      await attempt('https://forum.invalid/uploads/short-url/a.png'),
      await attempt('http://insecure.invalid/a.png'),
    ];`);
  assert.match(results[0], /denied|fetch failed|redirect/i);
  assert.match(results[1], /denied/);
  assert.equal(results[2], 302);
  assert.match(results[3], /denied/);
});

test('with no gap configured, serial requests go out back to back', () => {
  const {results, calls} = run(`
    const results = [
      await attempt('https://forum.invalid/a.json'),
      await attempt('https://forum.invalid/b.json'),
    ];`, {PET_HTTP_GAP_MS: '0'});
  assert.deepEqual(results, [200, 200]);
  assert.ok(calls[1].at - calls[0].at < 500, `waited ${calls[1].at - calls[0].at}ms`);
});

test('a 429 holds the next request back for the Retry-After the forum named', () => {
  const {results, calls} = run(`
    let first = true;
    globalThis.route = () => first ? (first = false, {status: 429, headers: {'retry-after': '1'}}) : {status: 200};
    const results = [
      await attempt('https://forum.invalid/a.json'),
      await attempt('https://forum.invalid/a.json'),
    ];`, {PET_HTTP_GAP_MS: '0'});
  assert.deepEqual(results, [429, 200]);
  const waited = calls[1].at - calls[0].at;
  assert.ok(waited >= 950, `only waited ${waited}ms`);
});

test('a negative gap is refused at load', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(policy)})`], {
    env: {PATH: process.env.PATH, PET_SITE: 'https://forum.invalid', PET_HTTP_GAP_MS: '-1'}, encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Missing MCP network policy/);
});
