import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAX_PDF_BYTES } from '../src/document.ts';
import type { PaperPassage } from '../src/document.ts';

let activeImports = 0;

export class PdfImportError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function decodeBase64(value: string, maxBytes: number): Buffer {
  if (
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new PdfImportError('Invalid or oversized base64 data.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new PdfImportError('Data is too large.', 413);
  return bytes;
}

export async function extractPdf(bytes: Buffer): Promise<PaperPassage[]> {
  if (bytes.length > MAX_PDF_BYTES) throw new PdfImportError('PDF exceeds 25 MiB.');
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new PdfImportError('Upload must contain a PDF.');
  }
  if (activeImports >= 2) {
    throw new PdfImportError('PDF importer busy; try again shortly.', 429);
  }
  activeImports += 1;
  try {
    return await new Promise<PaperPassage[]>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--max-old-space-size=256',
          fileURLToPath(new URL('./pdf-worker.ts', import.meta.url)),
        ],
        {
          stdio: ['pipe', 'pipe', 'ignore'],
          // Do not expose provider secrets or server credentials to the parser.
          env: { NODE_ENV: 'production' },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new PdfImportError('PDF could not be safely extracted.'));
      };
      const timer = setTimeout(fail, 15_000);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 12_000_000) fail();
        else chunks.push(chunk);
      });
      child.on('close', (code) => {
        if (finished) return;
        if (code !== 0) return fail();
        try {
          const pages = z
            .array(
              z.object({
                pageIndex: z.number().int().min(0).max(299),
                text: z.string().max(2_000_000),
              }),
            )
            .min(1)
            .max(300)
            .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (
            pages.some((page, index) => page.pageIndex !== index) ||
            pages.reduce((sum, page) => sum + page.text.length, 0) > 2_000_000
          ) {
            return fail();
          }
          finished = true;
          clearTimeout(timer);
          resolve(pages);
        } catch {
          fail();
        }
      });
      child.stdin.end(bytes);
    });
  } finally {
    activeImports -= 1;
  }
}
