// Read-only live check of the listening path through the plugin's own forum adapter.
// Runs on the host (repository credentials) or in the container. GET only; prints ids, floors and booleans.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';
import { Discourse } from '../plugins/shuiyuan-pet/dist/discourse.js';
import { sourceHash } from '../plugins/shuiyuan-pet/dist/context.js';

const path = relative => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const base = loadConfig(process.env.PET_CONFIG ?? path('config/pet.json'));
// Outside the container, use the repository's credentials and MCP install.
const host = existsSync(base.profilePath) ? {} : {profilePath: path('secrets/discourse-profile.json'), mcpScript: path('node_modules/@discourse/mcp/dist/index.js')};
const forum = new Discourse({...base, ...host, mode: 'draft', httpGapMs: 5000});
try {
  await forum.connect(); // also confirms the credential belongs to the configured owner
  const actions = await forum.actions(20);
  assert.ok(actions.every(a => Number.isSafeInteger(a.post_id) && Number.isFinite(Date.parse(a.created_at))));
  const types = {};
  for (const a of actions) types[a.action_type] = (types[a.action_type] ?? 0) + 1;
  console.log(JSON.stringify({actions: actions.length, types,
    newestFirst: actions.every((a, i) => i === 0 || Date.parse(actions[i - 1].created_at) >= Date.parse(a.created_at))}));
  const newest = actions[0];
  if (newest) {
    const window = await forum.readAround(newest.topic_id, newest.post_number, 11);
    const source = window.find(p => p.post_number === newest.post_number);
    const head = await forum.locate(newest.post_id);
    // The send preflight compares these two reads, so they must agree on an unchanged post.
    console.log(JSON.stringify({windowFloors: window.map(p => p.post_number), sourceFound: source?.id === newest.post_id,
      preflightMatchesWindow: !!source && sourceHash(head.raw) === sourceHash(source.raw)}));
  }
} finally { await forum.close(); }
