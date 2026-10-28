import {readFileSync} from 'node:fs';
const lock = JSON.parse(readFileSync(new URL('./runtime/package-lock.json', import.meta.url), 'utf8'));
const expected = lock.packages[''].dependencies['@deepseek-ai/dsh'];
for (const [path, pkg] of Object.entries(lock.packages)) {
  const name = path.slice(path.lastIndexOf('node_modules/') + 13);
  if ((name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/dsh') && pkg.version !== expected) {
    throw new Error(`${name}: ${pkg.version} differs from runtime ${expected}`);
  }
}
console.log(`DSH component lock verified: ${expected}`);
