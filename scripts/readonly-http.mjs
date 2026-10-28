// Preload for live read-only checks: GET to Shuiyuan only, 5s apart, request count on exit.
process.env.PET_SITE ??= 'https://shuiyuan.sjtu.edu.cn';
process.env.PET_HTTP_GAP_MS ??= '5000';
process.env.PET_ALLOW_WRITES = 'false';
process.env.PET_HTTP_REPORT = '1';
await import('./pet-http.mjs');
