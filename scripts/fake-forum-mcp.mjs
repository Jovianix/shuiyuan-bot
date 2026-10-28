// A stand-in for the Discourse MCP child, used to exercise the real harness, the real
// tool registration and the real model without touching a forum. Speaks newline-delimited
// JSON-RPC on stdio; the plugin spawns it exactly as it spawns the real server.
//
// The fixture is built to make a tool call necessary: the call quotes no floor and its
// question is about floors outside the read window that prepare() fetches, so a model
// that only reads the pre-fetched context cannot answer honestly.
const CALLER = {id: 29880, username: 'Tomorin'};
const TOPIC = 9001;
const now = new Date().toISOString();

const posts = [];
function post(id, floor, changes = {}) {
  posts.push({id, topic_id: TOPIC, post_number: floor, user_id: 40, username: 'curious',
    created_at: new Date(Date.now() - (200 - floor) * 60_000).toISOString(), updated_at: now,
    post_type: 1, reply_to_post_number: null,
    raw: `第 ${floor} 楼的内容。`, ...changes});
}
// The invocation: no quote markup, and it asks about floors the window does not contain.
post(59120, 120, {user_id: 29880, username: 'Tomorin',
  raw: '@Tomorin 【大肥鱼】刚才 105 到 114 楼大家吵了十楼，为了「该不该把米饭放凉再吃」争个不停。'
    + '我没看懂双方到底在争什么。你读一读那几楼，然后告诉我你站哪边，一句话就行。'});
post(59003, 3, {raw: '第 3 楼：米饭要趁热吃，凉了口感就毁了。'});
for (let floor = 105; floor <= 114; floor++) {
  post(59000 + floor, floor, {username: floor % 2 ? 'hawk' : 'dove',
    raw: floor % 2
      ? `第 ${floor} 楼：凉饭伤胃，这是常识，趁热吃才对。`
      : `第 ${floor} 楼：凉了再吃更好吃，而且不烫嘴，凭什么不行？`});
}

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
      const span = Math.min(args.limit ?? 11, 50);
      const floors = [];
      for (let f = Math.max(1, centre - Math.floor(span / 2)); f < centre + Math.ceil(span / 2); f++) floors.push(f);
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
    if (request.id === undefined) continue; // notification
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
        const value = handler(request.params.arguments ?? {});
        // The real server answers with one JSON text block; the plugin parses exactly that.
        result = {content: [{type: 'text', text: JSON.stringify(value)}], isError: false};
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
