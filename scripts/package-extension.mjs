import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const output = resolve('dist/brain-vat-chrome.zip');
await rm(output, { force: true });
const result = spawnSync('zip', ['-qr', output, '.'], {
  cwd: '.output/chrome-mv3',
  stdio: 'inherit',
});
if (result.status !== 0) throw new Error('Extension archive could not be created.');
