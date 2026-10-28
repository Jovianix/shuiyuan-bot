import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { builtinTools } from '../node_modules/@discourse/mcp/dist/tools/builtin/catalog.js';

const root = new URL('../', import.meta.url);
const profile = JSON.parse(await readFile(new URL('secrets/discourse-profile.json', root), 'utf8'));
assert.equal(profile.site, 'https://shuiyuan.sjtu.edu.cn');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '--import', fileURLToPath(new URL('readonly-http.mjs', import.meta.url)),
    fileURLToPath(new URL('node_modules/@discourse/mcp/dist/index.js', root)),
    '--profile', fileURLToPath(new URL('secrets/discourse-profile.json', root)),
    '--tools_mode', 'discourse_api_only',
    '--allow_writes', 'false', '--read_only', 'true',
    '--toolsets', 'topics,search,activity', '--timeout_ms', '60000',
  ],
  cwd: fileURLToPath(root), stderr: 'inherit',
});
const client = new Client({ name: 'shuiyuan-patch-check', version: '0.1.0' });
const allowed = new Set([
  'discourse_read_topic', 'discourse_read_topic_posts', 'discourse_read_post',
  'discourse_search_posts', 'discourse_filter_topics', 'discourse_get_post_replies',
]);
async function call(name, args) {
  assert.ok(allowed.has(name));
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const data = JSON.parse(response.content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
  assert.ok(!response.isError && !data.error, name + ': ' + (data.error ?? 'MCP error'));
  return data;
}
function passed(label, details = {}) {
  console.log(JSON.stringify({ check: label, ...details }));
}
try {
  await client.connect(transport);
  const registered = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    registered.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const writes = new Set(builtinTools.filter(t => t.availability === 'writes_enabled').map(t => t.name));
  assert.ok(registered.every(t => !writes.has(t.name)));
  passed('read-only registration', { tools: registered.length, write_tools: 0 });

  const topic = await call('discourse_read_topic', { topic_id: 447150, post_limit: 1 });
  assert.ok(topic.highest_post_number >= 4209);
  const latest = await call('discourse_read_topic_posts', { topic_id: 447150, selection_mode: 'latest', limit: 3 });
  assert.equal(latest.posts.length, 3);
  assert.ok(latest.posts.at(-1).post_number >= topic.highest_post_number);
  assert.ok(latest.posts.every(p => typeof p.raw === 'string'));
  passed('latest posts', { post_numbers: latest.posts.map(p => p.post_number) });

  const single = await call('discourse_read_post', { post_id: latest.posts.at(-1).id });
  assert.equal(single.raw, latest.posts.at(-1).raw);
  passed('exact post body matches latest selection');

  const middle = await call('discourse_read_topic_posts', {
    topic_id: 447150, selection_mode: 'around_post', post_number: 2100, limit: 3,
  });
  assert.ok(middle.posts.some(p => p.post_number === 2100));
  assert.equal(middle.meta.requested_post_found, true);
  passed('around-post includes target', { post_numbers: middle.posts.map(p => p.post_number) });

  const author = await call('discourse_read_topic_posts', {
    topic_id: 447150, selection_mode: 'usernames', usernames: ['tamaG'], replies_only: true, limit: 3,
  });
  assert.equal(author.posts.length, 3);
  assert.ok(author.posts.every(p => p.username === 'tamaG' && p.post_number > 1));
  passed('author selection', { post_numbers: author.posts.map(p => p.post_number) });

  const nearEnd = await call('discourse_read_topic', { topic_id: 447150, start_post_number: 4200, post_limit: 3 });
  assert.equal(nearEnd.meta.has_more, true);
  assert.equal(nearEnd.meta.next_post_number, nearEnd.posts.at(-1).post_number + 1);
  passed('topic continuation across missing floor numbers');

  const query = 'topic:447150 order:latest';
  const search = await call('discourse_search_posts', { query });
  assert.equal(search.meta.has_more, true);
  assert.equal(search.meta.next_page, 2);
  const second = await call('discourse_search_posts', { query, page: search.meta.next_page });
  assert.ok(second.posts.length > 0);
  passed('search pagination', { first_page: search.posts.length, second_page: second.posts.length });

  // A historical creation window keeps new posts from changing this test's order.
  const filter = 'tag:日记 created-after:2026-10-01 created-before:2026-10-26 order:created';
  const first = await call('discourse_filter_topics', { filter, per_page: 3 });
  assert.ok(first.meta.next_cursor);
  const next = await call('discourse_filter_topics', { filter, per_page: 3, cursor: first.meta.next_cursor });
  const six = await call('discourse_filter_topics', { filter, per_page: 6 });
  assert.deepEqual([...first.results, ...next.results].map(t => t.id), six.results.map(t => t.id));
  assert.equal(next.meta.offset, 3);
  passed('small-page cursor preserves all six topics');

  const replies = await call('discourse_get_post_replies', { post_id: 8035253, mode: 'direct_replies', include_raw: true });
  assert.ok(replies.posts.length > 0);
  assert.equal(replies.meta.raw_complete, true);
  assert.ok(replies.posts.every(p => typeof p.raw === 'string'));
  passed('reply bodies', { returned: replies.posts.length });
  passed('all patch checks passed; no mutation tools called');
} finally {
  await client.close();
  await transport.close();
}
