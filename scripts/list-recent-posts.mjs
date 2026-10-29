// Lists the newest activity entries with their post IDs, floors and topics, so a draft test
// can pick a real post. Read-only.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';
import { Discourse } from '../plugins/shuiyuan-pet/dist/discourse.js';

const path = relative => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const base = loadConfig(process.env.PET_CONFIG ?? path('config/pet.json'));
const host = existsSync(base.profilePath) ? {}
  : {profilePath: path('secrets/discourse-profile.json'), mcpScript: path('node_modules/@discourse/mcp/dist/index.js')};
const forum = new Discourse({...base, ...host, mode: 'draft', httpGapMs: 5000});
try {
  await forum.connect();
  const actions = await forum.actions(10);
  for (const a of actions) {
    console.log(JSON.stringify({post_id: a.post_id, topic: a.topic_id, floor: a.post_number,
      type: a.action_type, at: a.created_at}));
  }
} finally { await forum.close(); }
