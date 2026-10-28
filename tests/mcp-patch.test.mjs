import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { HttpClient } from '../node_modules/@discourse/mcp/dist/http/client.js';
import { builtinTools } from '../node_modules/@discourse/mcp/dist/tools/builtin/catalog.js';
import { registerToolDefinitions } from '../node_modules/@discourse/mcp/dist/tools/definition.js';

const catalog = new Map(builtinTools.map(tool => [tool.name, tool]));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network access is disabled in regression tests'); };
after(() => { globalThis.fetch = originalFetch; });
let fixtureId = 0;

function fixture(get, methods = {}) {
  const calls = [];
  const base = 'https://fixture-' + (++fixtureId) + '.invalid';
  const client = {
    get: async path => {
      calls.push(path);
      return get(new URL(path, base));
    },
    ...methods,
  };
  const ctx = {
    maxReadLength: 50000,
    siteState: {
      ensureSelectedSite: () => ({ base, client }),
      getSiteBase: () => base,
      getAuthType: () => 'user_api_key',
    },
  };
  return { ctx, calls, client };
}

async function invoke(name, args, setup, allowWrites = false) {
  const response = await catalog.get(name).handler(args, {}, setup.ctx, { allowWrites });
  return { error: response.isError === true, ...JSON.parse(response.content[0].text) };
}

function post(number, username = 'alice') {
  return { id: 1000 + number, topic_id: 77, post_number: number, username, raw: 'body ' + number };
}

function selectedFixture(posts, { initial = posts.slice(0, 2), ids = posts.map(p => p.id) } = {}) {
  return fixture(url => {
    if (url.pathname === '/t/77.json')
      return { post_stream: { stream: ids, posts: initial } };
    assert.equal(url.pathname, '/t/77/posts.json');
    const requested = new Set(url.searchParams.getAll('post_ids[]').map(Number));
    return { post_stream: { posts: posts.filter(p => requested.has(p.id)).reverse() } };
  });
}

test('latest selects the actual tail, deduplicates IDs and restores chronological order', async () => {
  const posts = [post(1), post(2), post(98), post(100), post(105)];
  const setup = selectedFixture(posts, { ids: [1001, 1002, 1002, 1098, 1100, 1105] });
  const result = await invoke('discourse_read_topic_posts', { topic_id: 77, selection_mode: 'latest', limit: 3 }, setup);
  assert.equal(result.error, false);
  assert.deepEqual(result.posts.map(p => p.post_number), [98, 100, 105]);
  assert.ok(result.posts.every(p => typeof p.raw === 'string'));
  assert.equal(result.meta.visible_stream_size, 5);
  assert.equal(setup.calls.length, 2);
  assert.ok(setup.calls.every(path => !path.includes('/post_ids.json')));
});

test('selected topic reads preserve archetype so consumers can exclude private messages', async () => {
  const setup = fixture(() => ({archetype: 'private_message', post_stream: {stream: [1001], posts: [post(1)]}}));
  const result = await invoke('discourse_read_topic_posts', {topic_id: 77, selection_mode: 'around_post', post_number: 1, limit: 1}, setup);
  assert.equal(result.archetype, 'private_message');
});

test('get_user without username verifies the authenticated identity without exposing credentials', async () => {
  const setup = fixture(url => {
    assert.equal(url.pathname, '/session/current.json');
    return {current_user: {id: 10, username: 'owner', auth_token: 'must-not-leak'}};
  });
  const result = await invoke('discourse_get_user', {}, setup);
  assert.equal(result.id, 10);
  assert.equal(result.username, 'owner');
  assert.equal(result.auth_token, undefined);
});

test('author selection excludes an injected OP and fills the requested count', async () => {
  const posts = [post(1, 'bob'), post(4), post(6), post(8)];
  const setup = selectedFixture(posts, { initial: [posts[0]], ids: [1001, 1001, 1004, 1006, 1008] });
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'usernames', usernames: ['ALICE'], limit: 3, replies_only: true,
  }, setup);
  assert.equal(result.error, false);
  assert.deepEqual(result.posts.map(p => p.post_number), [4, 6, 8]);
  assert.ok(result.posts.every(p => p.username === 'alice'));
  assert.equal(new URL(setup.calls[0], 'https://example.invalid').searchParams.get('username_filters'), 'ALICE');
});

test('replies_only keeps the first visible reply when the stream has no OP', async () => {
  const setup = selectedFixture([post(4), post(8), post(9)]);
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'earliest', limit: 2, replies_only: true,
  }, setup);
  assert.deepEqual(result.posts.map(p => p.post_number), [4, 8]);
});

test('around_post includes the target with context on each side', async () => {
  const posts = Array.from({ length: 15 }, (_, i) => post(90 + i));
  const setup = selectedFixture(posts, { initial: posts.slice(5) });
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'around_post', post_number: 100, limit: 3,
  }, setup);
  assert.deepEqual(result.posts.map(p => p.post_number), [99, 100, 101]);
  assert.equal(result.meta.requested_post_found, true);
});

test('around_post reports a missing target rather than claiming it was returned', async () => {
  const posts = [post(1), post(5), post(8)];
  const setup = selectedFixture(posts, { initial: posts });
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'around_post', post_number: 6, limit: 3,
  }, setup);
  assert.equal(result.meta.requested_post_found, false);
  assert.deepEqual(result.posts.map(p => p.post_number), [1, 5, 8]);
});

test('exact post selection preserves caller order and does not retry missing IDs', async () => {
  const setup = selectedFixture([post(1), post(5)]);
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'post_ids', post_ids: [1005, 1005, 1999, 1001],
  }, setup);
  assert.deepEqual(result.posts.map(p => p.id), [1005, 1001]);
  assert.equal(setup.calls.length, 1);
});

test('author selection has a hard request budget and reports partial results', async () => {
  const posts = Array.from({ length: 100 }, (_, i) => post(i + 1, 'bob'));
  const setup = selectedFixture(posts, { initial: [] });
  const result = await invoke('discourse_read_topic_posts', {
    topic_id: 77, selection_mode: 'usernames', usernames: ['alice'], limit: 1,
  }, setup);
  assert.equal(setup.calls.length, 5);
  assert.equal(result.meta.truncated_reason, 'request_limit');
  assert.equal(result.meta.exhaustive, false);
  assert.equal(result.posts.length, 0);
});

test('malformed streams are errors, not silently empty successful selections', async () => {
  const setup = fixture(() => ({ post_stream: { posts: [] } }));
  const result = await invoke('discourse_read_topic_posts', { topic_id: 77, selection_mode: 'latest' }, setup);
  assert.ok(result.error);
  assert.equal(setup.calls.length, 1);
});

test('topic continuation follows visible IDs despite missing post numbers', async () => {
  const posts = [post(1), post(140), post(145)];
  const setup = fixture(url => ({
    id: 77, posts_count: 3, highest_post_number: 145,
    post_stream: { stream: posts.map(p => p.id), posts: posts.filter(p => p.post_number >= Number(url.searchParams.get('post_number') ?? 1)) },
  }));
  const middle = await invoke('discourse_read_topic', { topic_id: 77, start_post_number: 140, post_limit: 1 }, setup);
  assert.equal(middle.meta.has_more, true);
  assert.equal(middle.meta.next_post_number, 141);
  const tail = await invoke('discourse_read_topic', { topic_id: 77, start_post_number: 145, post_limit: 1 }, setup);
  assert.equal(tail.meta.has_more, false);
  assert.equal(tail.meta.next_post_number, null);
  assert.equal(tail.highest_post_number, 145);
  assert.ok(setup.calls.every(path => path.includes('track_visit=false')));
});

test('topic continuation is unknown when the upstream omits both stream and boundary', async () => {
  const setup = fixture(() => ({ posts_count: 2, post_stream: { posts: [post(99)] } }));
  const result = await invoke('discourse_read_topic', { topic_id: 77, post_limit: 1 }, setup);
  assert.equal(result.meta.has_more, null);
});

test('search reads grouped pagination, preserves false, and reports the page limit', async () => {
  let grouped = { more_full_page_results: true, term: 'normalized term' };
  const setup = fixture(() => ({ posts: [post(1)], grouped_search_result: grouped, more_full_page_results: true }));
  const first = await invoke('discourse_search_posts', { query: 'term' }, setup);
  assert.equal(first.meta.has_more, true);
  assert.equal(first.meta.next_page, 2);
  assert.equal(first.meta.term, 'normalized term');
  const last = await invoke('discourse_search_posts', { query: 'term', page: 10 }, setup);
  assert.equal(last.meta.next_page, null);
  assert.equal(last.meta.truncated_reason, 'page_limit');
  grouped = { more_full_page_results: false };
  assert.equal((await invoke('discourse_search_posts', { query: 'term' }, setup)).meta.has_more, false);
});

test('small pages return every upstream topic exactly once using next_cursor', async () => {
  const topics = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: 'topic ' + (i + 1) }));
  const setup = fixture(url => {
    const page = Number(url.searchParams.get('page'));
    return { topic_list: { per_page: 6, topics: topics.slice(page * 6, page * 6 + 6), ...(page === 0 ? { more_topics_url: '/filter?page=1' } : {}) } };
  });
  const seen = [];
  let cursor;
  let turns = 0;
  do {
    const result = await invoke('discourse_filter_topics', { filter: 'tag:test', per_page: 3, ...(cursor ? { cursor } : {}) }, setup);
    assert.equal(result.error, false);
    assert.equal(result.meta.upstream_per_page, 6);
    assert.ok(result.results.length <= 3);
    seen.push(...result.results.map(t => t.id));
    cursor = result.meta.next_cursor;
    assert.equal(result.meta.has_more, cursor !== null);
    assert.ok(++turns <= 4);
  } while (cursor);
  assert.deepEqual(seen, topics.map(t => t.id));
  assert.deepEqual(setup.calls.map(path => Number(new URL(path, 'https://example.invalid').searchParams.get('page'))), [0, 0, 1, 1]);
});

test('topic-only search also reports upstream continuation when its local slice is full', async () => {
  const setup = fixture(() => ({
    topics: [{ id: 1, title: 'first match' }],
    grouped_search_result: { more_full_page_results: true },
  }));
  const result = await invoke('discourse_search', { query: 'match', max_results: 1 }, setup);
  assert.equal(result.meta.has_more, true);
});

test('cursor anchors survive insertion before the previous last result', async () => {
  let topics = [1, 2, 3, 4, 5, 6].map(id => ({ id }));
  const setup = fixture(() => ({ topic_list: { topics } }));
  const args = { filter: 'tag:test', per_page: 3 };
  const first = await invoke('discourse_filter_topics', args, setup);
  topics = [{ id: 99 }, ...topics];
  const next = await invoke('discourse_filter_topics', { ...args, cursor: first.meta.next_cursor }, setup);
  assert.deepEqual(next.results.map(t => t.id), [4, 5, 6]);
});

test('invalid, conflicting and cross-query cursors fail before HTTP', async () => {
  const setup = fixture(() => ({ topic_list: { topics: [{ id: 1 }, { id: 2 }] } }));
  const first = await invoke('discourse_filter_topics', { filter: 'tag:test', per_page: 1 }, setup);
  for (const args of [
    { filter: 'tag:test', per_page: 1, cursor: 'invalid' },
    { filter: 'tag:other', per_page: 1, cursor: first.meta.next_cursor },
    { filter: 'tag:test', per_page: 2, cursor: first.meta.next_cursor },
    { filter: 'tag:test', per_page: 1, cursor: first.meta.next_cursor, page: 1 },
  ]) assert.ok((await invoke('discourse_filter_topics', args, setup)).error);
  assert.equal(setup.calls.length, 1);
});

test('a removed cursor anchor produces an explicit stale-page error', async () => {
  let topics = [{ id: 1 }, { id: 2 }];
  const setup = fixture(() => ({ topic_list: { topics } }));
  const args = { filter: 'tag:test', per_page: 1 };
  const first = await invoke('discourse_filter_topics', args, setup);
  topics = [{ id: 2 }];
  assert.ok((await invoke('discourse_filter_topics', { ...args, cursor: first.meta.next_cursor }, setup)).error);
});

test('hot still routes to daily top, with bounded cursor continuation', async () => {
  const setup = fixture(url => {
    assert.equal(url.pathname, '/top.json');
    assert.equal(url.searchParams.get('period'), 'daily');
    return { topic_list: { topics: [{ id: 1 }] } };
  });
  const result = await invoke('discourse_filter_topics', { view: 'hot', per_page: 1 }, setup);
  assert.equal(result.meta.top_period, 'daily');
  assert.equal(result.meta.next_cursor, null);
});

test('reply bodies are hydrated in one batch without changing order or relationships', async () => {
  const rows = [post(8), post(4)].map(({ raw, ...p }) => ({ ...p, reply_to_post_number: 2 }));
  const setup = fixture(url => url.pathname === '/posts/1002/replies.json'
    ? rows
    : { post_stream: { posts: [post(4), post(8)] } });
  const result = await invoke('discourse_get_post_replies', { post_id: 1002, mode: 'direct_replies', include_raw: true }, setup);
  assert.deepEqual(result.posts.map(p => [p.post_number, p.raw, p.reply_to_post_number]), [[8, 'body 8', 2], [4, 'body 4', 2]]);
  assert.equal(result.meta.raw_complete, true);
  assert.equal(setup.calls.length, 2);
});

test('reply body hydration is optional and reports missing/inaccessible bodies', async () => {
  const setup = fixture(url => url.pathname.includes('/replies.json')
    ? [{ id: 1004, topic_id: 77, post_number: 4 }]
    : { post_stream: { posts: [] } });
  const plain = await invoke('discourse_get_post_replies', { post_id: 1002, mode: 'direct_replies' }, setup);
  assert.equal(plain.posts[0].raw, null);
  assert.equal(setup.calls.length, 1);
  const hydrated = await invoke('discourse_get_post_replies', { post_id: 1002, mode: 'direct_replies', include_raw: true }, setup);
  assert.equal(hydrated.meta.raw_complete, false);
});

test('reply hydration caps additional requests and disallows body reads in ID-only mode', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, topic_id: i + 1 }));
  const setup = fixture(url => url.pathname.includes('/reply-history.json')
    ? rows
    : { post_stream: { posts: [] } });
  const result = await invoke('discourse_get_post_replies', { post_id: 1002, mode: 'reply_history', include_raw: true }, setup);
  assert.equal(setup.calls.length, 5);
  assert.equal(result.meta.raw_complete, false);
  assert.ok((await invoke('discourse_get_post_replies', { post_id: 1002, include_raw: true }, setup)).error);
  assert.equal(setup.calls.length, 5);
});

test('reply-to-floor is passed to the no-retry endpoint and returned to callers', async () => {
  const sent = [];
  const setup = fixture(() => assert.fail('Unexpected GET'), {
    postNoRetry: async (path, payload) => {
      sent.push({ path, payload });
      return { id: 1999, topic_id: 77, post_number: 99, username: 'alice', reply_to_post_number: 42 };
    },
  });
  const args = { topic_id: 77, raw: 'test reply', reply_to_post_number: 42 };
  const result = await invoke('discourse_create_post', args, setup, true);
  assert.equal(result.error, false);
  assert.deepEqual(sent, [{ path: '/posts.json', payload: args }]);
  assert.equal(result.reply_to_post_number, 42);
  assert.equal(catalog.get('discourse_create_post').schema.safeParse({ ...args, reply_to_post_number: 0 }).success, false);
});

test('ordinary replies remain valid without a parent floor', async () => {
  const setup = fixture(() => assert.fail(), {
    postNoRetry: async (_path, payload) => {
      assert.equal('reply_to_post_number' in payload, false);
      return { id: 1999, topic_id: 77, post_number: 99, username: 'alice' };
    },
  });
  const result = await invoke('discourse_create_post', { topic_id: 77, raw: 'test reply' }, setup, true);
  assert.equal(result.error, false);
  assert.equal(result.reply_to_post_number, null);
});

test('failed topic/post creation is attempted exactly once even on HTTP 500', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return Response.json({ errors: ['uncertain server failure'] }, { status: 500 });
  });
  const setup = fixture(() => assert.fail());
  const client = new HttpClient({
    baseUrl: 'https://fixture.invalid', timeoutMs: 1000,
    auth: { type: 'none' }, logger: { debug() {}, error() {}, info() {} },
  });
  setup.ctx.siteState.ensureSelectedSite = () => ({ base: 'https://fixture.invalid', client });
  assert.ok((await invoke('discourse_create_post', { topic_id: 77, raw: 'test' }, setup, true)).error);
  assert.equal(attempts, 1);
  assert.ok((await invoke('discourse_create_topic', { title: 'test', raw: 'test' }, setup, true)).error);
  assert.equal(attempts, 2);
});

test('read-only registration and execution still reject all mutation tools', async () => {
  const setup = fixture(() => assert.fail('Unexpected request'), {
    postNoRetry: () => assert.fail('Unexpected mutation'),
  });
  const names = [];
  setup.ctx.server = { registerTool: name => names.push(name) };
  registerToolDefinitions(builtinTools, setup.ctx, { allowWrites: false, hideSelectSite: true, toolsets: ['topics', 'activity', 'search'] });
  const writes = new Set(builtinTools.filter(t => t.availability === 'writes_enabled').map(t => t.name));
  assert.ok(names.length > 0);
  assert.ok(names.every(name => !writes.has(name)));
  assert.ok((await invoke('discourse_create_post', { topic_id: 77, raw: 'test', reply_to_post_number: 42 }, setup)).error);
});
