// Run inside the pinned container after generating a real draft. Does not call any external API.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { extractAnswer } from '../plugins/shuiyuan-pet/dist/dsh.js';
import { AI_NOTE, replyBody } from '../plugins/shuiyuan-pet/dist/trigger.js';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';
const id = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(id) && id > 0, 'Provide a task ID');
const task = await new Promise((resolve, reject) => {
  request({socketPath: '/data/pet/control.sock', path: `/tasks/${id}`}, res => {
    let text = ''; res.on('data', part => {text += part;});
    res.on('end', () => {try {resolve(JSON.parse(text));} catch(error) {reject(error);}});
  }).on('error', reject).end();
});
assert.equal(task.state, 'draft_ready');
assert.equal(task.mode, 'draft');
const root = join(process.env.DSH_HOME ?? '/data/dsh', 'sessions');
const files = await readdir(root, {recursive: true});
const path = files.find(p => p.endsWith(`/${task.session_id}/session.v4.jsonl.zstd`));
assert.ok(path, 'DSH session artifact must survive outside process memory');
const raw = zstdDecompressSync(await readFile(join(root, path))).toString();
const events = raw.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type !== 'session');
const headers = events.filter(e => e.type === 'request/header').map(e => e.data.header);
assert.ok(headers.length > 0);
assert.ok(headers.every(h => !h.tools?.length), 'Pet model requests must not expose tools');
assert.ok(events.some(e => e.type === 'system/message' && e.data.message.content.some(b => b.text?.includes('大肥鱼'))));
const extracted = extractAnswer(events, task.session_id);
// The stored answer is the model's final text as forum text, then the AI note and the random hidden tag.
assert.ok(task.answer.text.startsWith(`${replyBody(extracted.text, loadConfig(process.env.PET_CONFIG).petName)}\n\n${AI_NOTE}\n\n`));
assert.deepEqual({...extracted, text: ''}, {...task.answer, text: ''});
const key = (await readFile('/run/secrets/deepseek-api-key', 'utf8')).trim();
assert.ok(!raw.includes(key), 'Model credential must not be logged in session context');
console.log(JSON.stringify({taskId: id, sourcePost: task.source_id, state: task.state,
  sessionId: task.session_id, soulHash: task.answer.soulHash, tools: [],
  model: headers[0].config.model, turnCompleted: true, persistentSession: true,
  published: task.sent_id !== null, answerCharacters: task.answer.text.length}, null, 2));
