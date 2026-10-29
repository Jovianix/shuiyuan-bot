import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  site: string; owner: string; ownerId: number; petId: string; petName: string;
  mode: 'draft' | 'reply'; scan: boolean; scanIntervalMs: number; scanPageSize: number; catchUpMs: number;
  reconcileIntervalMs: number; reconcileWindowMs: number;
  dataDir: string; profilePath: string; mcpScript: string; httpGapMs: number;
  provider: string; model: string; timeoutMs: number; maxTokens: number;
  relatedLimit: number; contextChars: number; maxAttempts: number;
  readCalls: number; readChars: number; readTotal: number; readSpan: number; imageBytes: number;
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
    // Serial, 2s after each response: at most ~30 requests a minute against Discourse's
    // default User API Key limit of 50/minute, leaving room for other use of the same key.
    mcpScript: '/app/node_modules/@discourse/mcp/dist/index.js', httpGapMs: 2000,
    provider: 'deepseek-official', model: 'deepseek-flash', timeoutMs: 180_000,
    maxTokens: 2048, relatedLimit: 4, contextChars: 12_000, maxAttempts: 3,
    // Model-initiated reads share the MCP child's single serial queue with scanning and
    // reconciliation, so one task may not spend the key's minute on its own curiosity.
    readCalls: 4, readChars: 6000, readTotal: 20_000, readSpan: 11,
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
  for (const key of ['scanIntervalMs', 'scanPageSize', 'catchUpMs', 'reconcileIntervalMs', 'reconcileWindowMs', 'httpGapMs', 'timeoutMs', 'maxTokens', 'contextChars', 'maxAttempts', 'imageBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (config.imageBytes > 20 * 1024 * 1024) throw new Error('imageBytes must not exceed the 20 MiB attachment limit');
  if (!Number.isSafeInteger(config.relatedLimit) || config.relatedLimit < 0 || config.relatedLimit > 8) throw new Error('Invalid relatedLimit');
  for (const key of ['dataDir', 'profilePath', 'mcpScript', 'controlSocket', 'workspace'] as const) config[key] = resolve(config[key]);
  return Object.freeze(config);
}
