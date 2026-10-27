import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { builtinTools } from '../node_modules/@discourse/mcp/dist/tools/builtin/catalog.js';

const root = new URL('../', import.meta.url);
const profile = JSON.parse(await readFile(new URL('discourse-profile.json', root), 'utf8'));
assert.equal(profile.site, 'https://shuiyuan.sjtu.edu.cn');

const transport = new StdioClientTransport({
  command: process.execPath,
  // Explicitly override the profile, even when normal MCP sessions allow writes.
  args: [
    '--import', fileURLToPath(new URL('readonly-http.mjs', import.meta.url)),
    fileURLToPath(new URL('node_modules/@discourse/mcp/dist/index.js', root)),
    '--profile', fileURLToPath(new URL('discourse-profile.json', root)),
    '--tools_mode', 'discourse_api_only', '--allow_writes', 'false', '--read_only', 'true',
  ],
  cwd: fileURLToPath(root),
  stderr: 'inherit',
});
const client = new Client({ name: 'shuiyuan-readonly-check', version: '0.1.0' });

async function readTool(name, args) {
  assert.ok(['discourse_search', 'discourse_read_topic', 'discourse_read_post'].includes(name));
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.ok(text, `${name} returned no JSON text.`);
  const data = JSON.parse(text);
  assert.ok(!result.isError && !data.error, `${name} failed; check server diagnostics.`);
  return data;
}

try {
  await client.connect(transport);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const writeNames = new Set(builtinTools
    .filter(tool => tool.availability === 'writes_enabled')
    .map(tool => tool.name));
  const exposedWrites = tools.filter(tool => writeNames.has(tool.name));
  assert.equal(exposedWrites.length, 0, 'The server exposed write tools.');
  for (const name of ['discourse_search', 'discourse_read_topic', 'discourse_read_post']) {
    assert.ok(tools.some(tool => tool.name === name), `${name} was not registered.`);
  }
  console.log(JSON.stringify({
    check: 'MCP initialize and tools/list',
    server: client.getServerVersion(),
    registered_tools: tools.length,
    registered_write_tools: exposedWrites.length,
  }, null, 2));

  const search = await readTool('discourse_search', {
    query: 'tags:水源开发者', max_results: 3,
  });
  assert.ok(Array.isArray(search.results) && search.results.length > 0, 'Search returned no topics.');
  console.log(JSON.stringify({
    check: 'discourse_search',
    results: search.results,
    has_more: search.meta?.has_more,
  }, null, 2));

  // This is the archive-tool topic already supplied by the user.
  const topic = await readTool('discourse_read_topic', { topic_id: 43559, post_limit: 2 });
  assert.equal(topic.id, 43559);
  assert.ok(Array.isArray(topic.posts) && topic.posts.length > 0, 'Topic returned no posts.');
  assert.ok(typeof topic.posts[0].raw === 'string' && topic.posts[0].raw.length > 0);
  console.log(JSON.stringify({
    check: 'discourse_read_topic',
    id: topic.id,
    title: topic.title,
    total_posts: topic.posts_count,
    returned_posts: topic.posts.length,
    first_post_excerpt: topic.posts[0].raw.slice(0, 200),
    has_more: topic.meta?.has_more,
  }, null, 2));

  const post = await readTool('discourse_read_post', { post_id: topic.posts[0].id });
  assert.equal(post.id, topic.posts[0].id);
  assert.equal(post.topic_id, topic.id);
  assert.ok(typeof post.raw === 'string' && post.raw.length > 0);
  console.log(JSON.stringify({
    check: 'discourse_read_post',
    id: post.id,
    topic_id: post.topic_id,
    returned_characters: post.raw.length,
    truncated: post.truncated,
  }, null, 2));
  console.log('PASS: MCP reads succeeded; no write tools were exposed or called.');
} finally {
  await client.close();
  await transport.close();
}
