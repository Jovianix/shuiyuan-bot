// Prints a few candidate posts (floor, parent, first 160 chars of body) so a draft test can
// pick one whose answer needs context outside the pre-fetch window. Read-only.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';
import { Discourse } from '../plugins/shuiyuan-pet/dist/discourse.js';

const path = relative => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const base = loadConfig(process.env.PET_CONFIG ?? path('config/pet.json'));
const host = existsSync(base.profilePath) ? {}
  : {profilePath: path('secrets/discourse-profile.json'), mcpScript: path('node_modules/@discourse/mcp/dist/index.js')};
const forum = new Discourse({...base, ...host, mode: 'draft', httpGapMs: 5000});

// post id:topic:floor pairs chosen from the newest activity page
const candidates = process.argv.slice(2).map(arg => {
  const [id, topic, floor] = arg.split(':').map(Number);
  return {id, topic, floor};
});

try {
  await forum.connect();
  for (const c of candidates) {
    try {
      const posts = await forum.readAround(c.topic, c.floor, 3);
      const post = posts.find(p => p.post_number === c.floor);
      if (!post) { console.log(`${c.id} floor ${c.floor}: not visible`); continue; }
      const body = post.raw.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`\n=== post ${post.id} (topic ${c.topic} floor ${c.floor}, parent ${post.reply_to_post_number}) ===`);
      console.log(body);
    } catch (error) {
      console.log(`${c.id}: ${error.message}`);
    }
  }
} finally { await forum.close(); }
