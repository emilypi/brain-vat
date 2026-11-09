import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const skipped = new Set([
  'node_modules',
  '.git',
  '.wxt',
  '.output',
  'dist',
  'public',
  'logs',
  '.Codex',
  'test-results',
  'playwright-report',
  'coverage',
]);
let failures = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(?:tsx?|m?js|css|html)$/.test(entry.name)) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (line.length > 90) {
          console.error(`${path}:${index + 1} exceeds 90 columns (${line.length}).`);
          failures += 1;
        }
      });
    }
  }
}
await check('.');
if (failures) process.exitCode = 1;
