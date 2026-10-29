// Verifies the real MCP's discourse_read_topic shape against what topicInfo() expects.
// Read-only, one request.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';
import { Discourse } from '../plugins/shuiyuan-pet/dist/discourse.js';

const path = relative => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const base = loadConfig(process.env.PET_CONFIG ?? path('config/pet.json'));
const host = existsSync(base.profilePath) ? {}
  : {profilePath: path('secrets/discourse-profile.json'), mcpScript: path('node_modules/@discourse/mcp/dist/index.js')};
const forum = new Discourse({...base, ...host, mode: 'draft', httpGapMs: 5000});
const topic = Number(process.argv[2] ?? 447150);
try {
  await forum.connect();
  const raw = await forum.call('discourse_read_topic', {topic_id: topic, post_limit: 1});
  console.log('raw keys:', Object.keys(raw).join(', '));
  console.log('raw values:', JSON.stringify({id: raw.id, title: raw.title, slug: raw.slug,
    category_id: raw.category_id, tags: raw.tags, posts_count: raw.posts_count,
    highest_post_number: raw.highest_post_number, archetype: raw.archetype}).slice(0, 400));
  const info = await forum.topicInfo(topic);
  console.log('topicInfo():', JSON.stringify(info).slice(0, 400));
} finally { await forum.close(); }
