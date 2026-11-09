import { identifyPdf, MAX_PDF_BYTES } from './document';
import type { Paper } from './document';

export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`The PDF server returned ${response.status}.`);
  if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) {
    await response.body?.cancel();
    throw new Error('Choose a PDF under 25 MB.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The server returned an empty file.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF_BYTES) throw new Error('Choose a PDF under 25 MB.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function createPaper(
  bytes: ArrayBuffer,
  filename: string,
  sourceUrl: string | null,
): Promise<Paper> {
  return {
    id: await identifyPdf(bytes),
    title: filename.replace(/\.pdf$/i, '').slice(0, 500),
    filename,
    sourceUrl,
    bytes,
    addedAt: new Date().toISOString(),
    pageCount: 0,
  };
}
