import { readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { loadConfig } from '../plugins/shuiyuan-pet/dist/config.js';

process.umask(0o077);
const petConfig = loadConfig(process.env.PET_CONFIG ?? '/app/config/pet.json');
// The Dockerfile's flock on /data/pet.instance.lock keeps a second container off this volume.
await mkdir(petConfig.dataDir, {recursive: true, mode: 0o700});
const requireRuntime = createRequire('/opt/dsh/package.json');
const {initProfile, PROFILE_TEMPLATES} = await import(requireRuntime.resolve('@deepseek-ai/dsh-app-boot'));
const home = process.env.DSH_HOME ?? '/data/dsh';
const profile = join(home, 'profiles', 'pet');
await mkdir(profile, {recursive: true});
const exists = async path => !!await lstat(path).catch(() => null);
if (!await exists(join(profile, 'package.json'))) await initProfile(profile, PROFILE_TEMPLATES.web.bundles);
const modules = join(profile, 'node_modules');
if (!await exists(modules)) await symlink('/opt/dsh/node_modules', modules);
else if (!(await lstat(modules)).isSymbolicLink()) throw new Error('Profile node_modules must use image dependencies; back up the profile before migration');
const manifest = JSON.parse(await readFile('/opt/dsh/package.json', 'utf8')).dependencies;
const marker = join(home, 'pet-runtime.json');
if (await exists(marker)) {
  const previous = JSON.parse(await readFile(marker, 'utf8'));
  if (JSON.stringify(previous) !== JSON.stringify(manifest) && process.env.PET_ACCEPT_RUNTIME_UPDATE !== '1') {
    throw new Error('Runtime changed. Stop old instance, back up /data, then set PET_ACCEPT_RUNTIME_UPDATE=1 for the migration start.');
  }
}
await writeFile(marker, JSON.stringify(manifest));
const soul = await readFile('/app/config/soul.md', 'utf8');
const seedMarker = join(home, 'pet-profile-initialized');
if (!await exists(seedMarker)) {
  // JSON is valid YAML. This is user-managed after initialization, including Soul edits in Web.
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{insert: [{id: 'soul-md', name: 'dsh-soul-md', config: {
    cards: {'大肥鱼': soul}, active: '大肥鱼', complete: true, memory: {inject: false, recall: 'off'},
  }}]}], null, 2));
  await writeFile(seedMarker, '1');
}
// Runtime policy is an overlay, separate from mutable user settings and immutable image dependencies.
const overlay = join(home, 'pet-runtime.patch.yml');
await writeFile(overlay, JSON.stringify([
  {id: 'session-log-deepseek', disabled: true},
  {id: 'session-title-llm', disabled: true},
  {id: 'agent-preset-registry', config: {default: 'pet'}},
  {insert: [
    {id: 'preset-pet', name: '@deepseek-ai/dsh-agent-preset', config: {id: 'pet', order: 0, plugins: []}},
    {id: 'shuiyuan-pet', name: '/app/plugins/shuiyuan-pet/dist/index.js'},
  ]},
], null, 2));
const key = (await readFile('/run/secrets/deepseek-api-key', 'utf8')).trim();
if (!key || /\s/.test(key)) throw new Error('DeepSeek credential file is empty or malformed');
const ip = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address;
if (!ip) throw new Error('No container IPv4 address found');
const child = spawn(process.execPath, [requireRuntime.resolve('@deepseek-ai/dsh/lib/bin.js'), '--profile', 'pet',
  '--patch', overlay, '--no-open', '--host', ip, '--port', '3080', '--public-url', 'http://localhost:3080',
  '--trusted-host', 'localhost:3080', '127.0.0.1:3080'], {
  cwd: '/app', stdio: 'inherit', env: {...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key},
});
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Drain the plugin before the host concurrently disposes its dependent services.
  await new Promise(resolve => {
    const req = request({socketPath: petConfig.controlSocket, path: '/shutdown', method: 'POST'}, res => {
      res.resume(); res.on('end', resolve);
    });
    req.setTimeout(30_000, () => req.destroy());
    req.on('error', resolve); req.end();
  });
  child.kill(signal);
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
