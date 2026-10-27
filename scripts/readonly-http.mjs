// Preload only for live read checks. It covers startup, retries and multi-request tools.
import { setTimeout as delay } from 'node:timers/promises';

const originalFetch = globalThis.fetch;
let tail = Promise.resolve();
let lastFinished = 0;
let requests = 0;
let minimumGap = Infinity;

globalThis.fetch = (input, init = {}) => {
  const operation = tail.then(async () => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== 'https://shuiyuan.sjtu.edu.cn' || method !== 'GET') {
      throw new Error('Live checks permit only GET requests to Shuiyuan');
    }
    while (Date.now() < lastFinished + 5000) {
      await delay(lastFinished + 5000 - Date.now());
    }
    if (lastFinished) minimumGap = Math.min(minimumGap, Date.now() - lastFinished);
    requests++;
    try {
      const response = await originalFetch(input, { ...init, redirect: 'error' });
      await response.clone().arrayBuffer();
      return response;
    } finally {
      lastFinished = Date.now();
    }
  });
  tail = operation.catch(() => {});
  return operation;
};

process.on('exit', () => {
  process.stderr.write(JSON.stringify({
    check: 'HTTP read-only pacing',
    requests,
    min_gap_ms: Number.isFinite(minimumGap) ? minimumGap : null,
  }) + '\n');
});
