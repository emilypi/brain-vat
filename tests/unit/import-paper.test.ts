import { afterEach, expect, it, vi } from 'vitest';
import { fetchPdf } from '../../src/import-paper';
import { MAX_PDF_BYTES } from '../../src/document';

afterEach(() => vi.unstubAllGlobals());

it('stops an oversized streaming response even without a content length', async () => {
  const cancel = vi.fn();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(MAX_PDF_BYTES / 2 + 1));
    },
    cancel,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
  await expect(fetchPdf('https://example.org/paper.pdf')).rejects.toThrow('25 MB');
  expect(cancel).toHaveBeenCalledOnce();
  expect(sent).toBeLessThanOrEqual(3);
});

it('rejects an oversized declared length before reading the body', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { 'content-length': String(MAX_PDF_BYTES + 1) },
      }),
    ),
  );
  await expect(fetchPdf('https://example.org/paper.pdf')).rejects.toThrow('25 MB');
  expect(cancel).toHaveBeenCalledOnce();
});

it('combines streaming chunks without changing document bytes', async () => {
  const first = new TextEncoder().encode('%PDF-1.7\n');
  const second = new TextEncoder().encode('sample');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
  const fetch = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal('fetch', fetch);
  expect(
    new TextDecoder().decode(await fetchPdf('https://example.org/paper.pdf')),
  ).toBe('%PDF-1.7\nsample');
  expect(fetch.mock.calls[0]?.[1].credentials).toBe('omit');
});
