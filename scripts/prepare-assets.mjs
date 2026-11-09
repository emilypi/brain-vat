import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const target = resolve(root, '../public/pdfjs');
await mkdir(target, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(resolve(pdfjs, folder), resolve(target, folder), { recursive: true });
}
