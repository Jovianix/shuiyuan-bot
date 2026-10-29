import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  site: string; owner: string; ownerId: number; petId: string; petName: string;
  mode: 'draft' | 'reply'; scan: boolean; scanIntervalMs: number; scanPageSize: number; catchUpMs: number;
  reconcileIntervalMs: number; reconcileWindowMs: number;
  dataDir: string; profilePath: string; mcpScript: string; httpGapMs: number;
  provider: string; model: string; timeoutMs: number; maxTokens: number;
  relatedLimit: number; contextChars: number; maxAttempts: number;
  readChars: number; readSpan: number; imageBytes: number;
  controlSocket: string; workspace: string;
}
export function loadConfig(path: string): Config {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const config: Config = {
    site: 'https://shuiyuan.sjtu.edu.cn', owner: '', ownerId: 0,
    petId: 'fish', petName: '大肥鱼', mode: 'draft', scan: false,
    // One request per scan whatever the page size; 20 covers a burst of calls between two scans.
    scanIntervalMs: 60_000, scanPageSize: 20, catchUpMs: 3 * 3_600_000,
    reconcileIntervalMs: 300_000, reconcileWindowMs: 1_800_000,
    dataDir: '/data/pet', profilePath: '/run/secrets/discourse-profile.json',
    // Requests stay serial, one in flight, but with no fixed wait between them: at this
    // scale a pause buys nothing. The forum's own 429 + Retry-After paces us when it must
    // (Discourse's User API Key default is 20/minute, 2880/day). Raise this only if the site
    // turns out to throttle even serial traffic.
    mcpScript: '/app/node_modules/@discourse/mcp/dist/index.js', httpGapMs: 0,
    provider: 'deepseek-official', model: 'deepseek-flash', timeoutMs: 180_000,
    maxTokens: 2048, relatedLimit: 4, contextChars: 12_000, maxAttempts: 3,
    // No cap on how many reads a task makes: the MCP child keeps requests serial and backs
    // off when the forum says so, so a curious model costs time, not a burst of traffic.
    // readChars bounds one result so a single 50-floor read cannot fill the model's context;
    // readSpan is only the default window, which the model may widen per call.
    readChars: 6000, readSpan: 11,
    // One image, as the forum stores it. Well under the harness's own 20 MiB admission cap:
    // a post image past this size is a scan or a screenshot dump, not something to discuss.
    imageBytes: 5 * 1024 * 1024,
    controlSocket: '/data/pet/control.sock', workspace: '/data/workspace', ...data,
  };
  const site = new URL(config.site);
  if (site.protocol !== 'https:' || site.origin !== config.site) throw new Error('site must be an HTTPS origin');
  if (!/^[\w.-]+$/.test(config.owner) || !Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) throw new Error('Configure owner and stable ownerId');
  if (!/^[\w-]+$/.test(config.petId) || !config.petName.trim() || /[【】\r\n]/u.test(config.petName)) throw new Error('Invalid pet identity');
  if (!['draft', 'reply'].includes(config.mode) || typeof config.scan !== 'boolean') throw new Error('Invalid mode or scan');
  for (const key of ['scanIntervalMs', 'scanPageSize', 'catchUpMs', 'reconcileIntervalMs', 'reconcileWindowMs', 'timeoutMs', 'maxTokens', 'contextChars', 'maxAttempts', 'readChars', 'readSpan', 'imageBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isSafeInteger(config.httpGapMs) || config.httpGapMs < 0) throw new Error('Invalid httpGapMs');
  if (config.imageBytes > 20 * 1024 * 1024) throw new Error('imageBytes must not exceed the 20 MiB attachment limit');
  if (!Number.isSafeInteger(config.relatedLimit) || config.relatedLimit < 0 || config.relatedLimit > 8) throw new Error('Invalid relatedLimit');
  for (const key of ['dataDir', 'profilePath', 'mcpScript', 'controlSocket', 'workspace'] as const) config[key] = resolve(config[key]);
  return Object.freeze(config);
}
