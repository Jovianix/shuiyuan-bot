// A stand-in for the Discourse MCP child, used to exercise the real harness, the real
// tool registration and the real model without touching a forum. Speaks newline-delimited
// JSON-RPC on stdio; the plugin spawns it exactly as it spawns the real server.
//
// Scenario: a substantive post about AI and social science sits at floor 30. The invocation
// sits at floor 31 as a REPLY to it or as a STANDALONE post that only says "是这样吗". In the
// standalone case the pre-fetched context contains nothing but those four characters, so the
// model must choose to read.
//
// The scenario comes from a mounted file rather than the environment: the plugin gives the
// MCP child only PATH, PET_SITE, PET_HTTP_GAP_MS and PET_ALLOW_WRITES, so nothing else reaches
// it through env.
import { readFileSync } from 'node:fs';

const CALLER = {id: 29880, username: 'Tomorin'};
const TOPIC = 9002;
const scenario = (() => {
  try { return readFileSync('/data/scenario', 'utf8').trim() || 'bare'; }
  catch { return 'bare'; }
})();
const now = new Date().toISOString();

const REPORT = '第三个报告讲的是 ai 与社会科学。以前没怎么了解过这方面的话题，听着挺有收获的。'
  + 'ai 和过去的工具不同，它具有很高的拟人性，因此能深度参与和改变人的社交模式。'
  + '报告里说，已经有相当一部分比例的人将 ai 视作能倾诉的「朋友」。'
  + '包括现在非常流行的鲸鱼娘，某种程度上也折射了人们对社交的期待吧。'
  + '十年后、二十年后回过头看，ai 对社会的改变能像互联网一样深刻吗？很好奇这个问题的答案。';

const posts = [];
function post(id, floor, changes = {}) {
  posts.push({id, topic_id: TOPIC, post_number: floor, user_id: 40, username: 'curious',
    created_at: new Date(Date.now() - (200 - floor) * 60_000).toISOString(), updated_at: now,
    post_type: 1, reply_to_post_number: null,
    raw: `第 ${floor} 楼的内容。`, ...changes});
}
post(90030, 30, {user_id: 41, username: 'thinker', raw: REPORT});
// The invocation. In the bare case it points at nothing, so prepare() yields no related posts.
post(90031, 31, {user_id: 29880, username: 'Tomorin', reply_to_post_number: scenario === 'reply' ? 30 : null,
  raw: '@Tomorin 【大肥鱼】是这样吗'});
for (let floor = 25; floor <= 29; floor++) post(90000 + floor, floor, {raw: `第 ${floor} 楼：一些无关的闲聊。`});

const topicPosts = (topic, floors) => posts
  .filter(p => p.topic_id === topic && (floors === undefined || floors.includes(p.post_number)))
  .sort((a, b) => a.post_number - b.post_number);

const handlers = {
  discourse_get_user: () => ({...CALLER, name: '火花@Official'}),
  discourse_list_user_actions: () => ({actions: []}),
  discourse_read_post: ({post_id}) => {
    const found = posts.find(p => p.id === post_id);
    if (!found) throw Object.assign(new Error('not found'), {status: 404});
    return {id: found.id, topic_id: found.topic_id, post_number: found.post_number, raw: found.raw};
  },
  discourse_read_topic_posts: args => {
    const topic = args.topic_id;
    if (args.selection_mode === 'post_ids') {
      return {topic_id: topic, archetype: null, selection_mode: 'post_ids',
        posts: posts.filter(p => args.post_ids.includes(p.id) && p.topic_id === topic)};
    }
    if (args.selection_mode === 'around_post') {
      const centre = args.post_number;
      // Mirror Discourse: the target plus the five floors before it.
      const floors = [];
      for (let f = Math.max(1, centre - 5); f <= centre; f++) floors.push(f);
      return {topic_id: topic, archetype: 'regular', selection_mode: 'around_post', posts: topicPosts(topic, floors)};
    }
    return {topic_id: topic, archetype: 'regular', selection_mode: args.selection_mode ?? 'latest',
      posts: topicPosts(topic).slice(0, args.limit ?? 20)};
  },
  discourse_get_post_replies: ({post_id}) => {
    const target = posts.find(p => p.id === post_id);
    return {post_id, mode: 'reply_history', posts: target && target.reply_to_post_number
      ? posts.filter(p => p.post_number === target.reply_to_post_number) : [], meta: {returned: 0}};
  },
  discourse_search_posts: ({query}) => ({
    posts: posts.filter(p => p.raw.includes(query)).map(p => ({
      id: p.id, topic_id: p.topic_id, post_number: p.post_number, user_id: p.user_id,
      username: p.username, created_at: p.created_at, excerpt: `${p.raw.slice(0, 60)}…`,
    })), topics: []}),
  discourse_create_post: () => { throw Object.assign(new Error('posting disabled in the fixture'), {status: 403}); },
};

const tools = [
  {name: 'discourse_get_user', description: 'Read the authenticated user', inputSchema: {type: 'object', properties: {}}},
  {name: 'discourse_list_user_actions', description: 'List user actions', inputSchema: {type: 'object', properties: {}}},
  {name: 'discourse_read_post', description: 'Read one post', inputSchema: {type: 'object', properties: {post_id: {type: 'integer'}}}},
  {name: 'discourse_read_topic_posts', description: 'Read topic posts', inputSchema: {type: 'object', properties: {}}},
  {name: 'discourse_get_post_replies', description: 'Read reply relationships', inputSchema: {type: 'object', properties: {post_id: {type: 'integer'}}}},
  {name: 'discourse_search_posts', description: 'Search posts', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}},
  {name: 'discourse_create_post', description: 'Create a post', inputSchema: {type: 'object', properties: {}}},
];

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    try {
      let result;
      if (request.method === 'initialize') {
        result = {protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
          capabilities: {tools: {}}, serverInfo: {name: 'fake-forum', version: '1'}};
      } else if (request.method === 'tools/list') {
        result = {tools};
      } else if (request.method === 'tools/call') {
        const handler = handlers[request.params.name];
        if (!handler) throw new Error(`Unknown tool ${request.params.name}`);
        result = {content: [{type: 'text', text: JSON.stringify(handler(request.params.arguments ?? {}))}], isError: false};
      } else {
        result = {};
      }
      write({jsonrpc: '2.0', id: request.id, result});
    } catch (error) {
      write({jsonrpc: '2.0', id: request.id, result: {
        content: [{type: 'text', text: JSON.stringify({error: error.message, status: error.status})}],
        isError: true}});
    }
  }
});
