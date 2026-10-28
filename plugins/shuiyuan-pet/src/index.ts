import { mkdir, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Discourse } from './discourse.js';
import { Store } from './store.js';
import { Discovery } from './discovery.js';
import { Activities } from './activities.js';
import { DshModel, type DshContext } from './dsh.js';

export const name = 'shuiyuan-pet';
export const inject = ['agents', 'tools', 'systemPrompt', 'sessions', 'sessionPersistence'];
// The container lock keeps other processes off the database. Within this process, a reload
// stops the previous instance first, so there is never a second worker able to send.
const RUNNING = Symbol.for('shuiyuan-pet.stop');
const running = globalThis as {[RUNNING]?: () => Promise<void>};
export async function apply(ctx: DshContext): Promise<void> {
  await running[RUNNING]?.();
  const config = loadConfig(process.env.PET_CONFIG ?? '/app/config/pet.json');
  await mkdir(config.dataDir, {recursive: true, mode: 0o700});
  await mkdir(config.workspace, {recursive: true, mode: 0o700});
  const store = new Store(join(config.dataDir, 'pet.sqlite'), config.site, config.petId);
  const abort = new AbortController();
  const forum = new Discourse(config);
  const model = new DshModel(ctx, config);
  const activities = new Activities(store, forum, model, config);
  const discovery = new Discovery(store, forum, config);
  const pending = new Set<Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  function schedule(kind: string, run: () => Promise<unknown>): void {
    if (stopping) return;
    const promise = run().catch((error: Error) => {
      store.setMeta(`error:${kind}`, {at: Date.now(), message: error.message});
    }).finally(() => pending.delete(promise));
    pending.add(promise);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/status') {
        const counts = store.counts();
        res.end(JSON.stringify({mode: config.mode, scan: config.scan, paused: !!store.getMeta('paused'), counts,
          discovery: store.getMeta('scan'),
          errors: ['connect','scan','worker','reconcile'].map(k => store.getMeta(`error:${k}`)).filter(Boolean)}));
      } else if (req.method === 'GET' && /^\/tasks(?:\/\d+)?$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[2]);
        res.end(JSON.stringify(id ? store.task(id) : store.list().map(({id, source_id, state, error, session_id, sent_id}) => ({id, source_id, state, error, session_id, sent_id}))));
      } else if (req.method === 'POST' && /^\/draft\/\d+$/.test(url.pathname)) {
        const id = store.enqueue(Number(url.pathname.split('/')[2]), 'draft', 'manual');
        res.end(JSON.stringify({taskId: id}));
      } else if (req.method === 'POST' && /^\/retry\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[2]);
        if (store.task(id).state !== 'failed') throw new Error('Only failed tasks can be retried');
        store.update(id, {state: 'queued', mode: 'draft', attempts: 0, available_at: 0, error: null});
        res.end(JSON.stringify({taskId: id, mode: 'draft'}));
      } else if (req.method === 'POST' && url.pathname === '/shutdown') {
        await stop();
        res.end(JSON.stringify({stopped: true}));
      } else if (req.method === 'POST' && ['/pause','/resume','/scan','/reconcile'].includes(url.pathname)) {
        if (url.pathname === '/pause' || url.pathname === '/resume') store.setMeta('paused', url.pathname === '/pause');
        if (url.pathname === '/scan') schedule('scan', () => discovery.scan());
        if (url.pathname === '/reconcile') schedule('reconcile', () => activities.reconcile(true));
        res.end(JSON.stringify({accepted: true}));
      } else { res.statusCode = 404; res.end('{}'); }
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({error: (error as Error).message})); }
  });
  let stopped: Promise<void> | undefined;
  // Every caller, including a reload, waits for the same complete shutdown.
  function stop(): Promise<void> {
    return stopped ??= (async () => {
      stopping = true;
      timers.forEach(clearInterval);
      abort.abort();
      server.close();
      // Closing the transport also releases pending MCP requests before waiting.
      try { await forum.close(); }
      finally {
        await Promise.allSettled(pending);
        await rm(config.controlSocket, {force: true});
        store.close();
        if (running[RUNNING] === stop) delete running[RUNNING];
      }
    })();
  }
  running[RUNNING] = stop;
  ctx.on('dispose', stop);
  try {
    // Not fatal: a forum outage at startup is retried by the next scan or task.
    await forum.connect().catch((error: Error) => store.setMeta('error:connect', {at: Date.now(), message: error.message}));
    await activities.recover();
    await rm(config.controlSocket, {force: true});
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.controlSocket, resolve); });
    await chmod(config.controlSocket, 0o600);
    timers.push(setInterval(() => schedule('worker', () => activities.tick(abort.signal)), 1000));
    // Unknown sends are only resolved by re-reading the topic; without this they wait for a manual reconcile.
    timers.push(setInterval(() => schedule('reconcile', () => activities.reconcile()), config.reconcileIntervalMs));
    if (config.scan) {
      schedule('scan', () => discovery.scan());
      timers.push(setInterval(() => schedule('scan', () => discovery.scan()), config.scanIntervalMs));
    }
    console.info('shuiyuan-pet ready', JSON.stringify({mode: config.mode, scan: config.scan}));
  } catch (error) { await stop(); throw error; }
}
