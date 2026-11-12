import { describe, expect, test, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { loadPageSizes } from '../../src/pdf-reader';

function page(width = 600, height = 800): PDFPageProxy {
  return { getViewport: () => ({ width, height }) } as PDFPageProxy;
}

describe('progressive PDF page layout', () => {
  test('publishes page one while a later page is still loading', async () => {
    let finish!: (value: PDFPageProxy) => void;
    const later = new Promise<PDFPageProxy>((resolve) => {
      finish = resolve;
    });
    const getPage = vi.fn(async (number: number) => (number === 1 ? page() : later));
    const publish = vi.fn();
    const loading = loadPageSizes(
      { numPages: 3, getPage },
      publish,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
    expect(publish).toHaveBeenCalledExactlyOnceWith([
      { width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 600, height: 800 },
    ]);
    finish(page(800, 600));
    await loading;
    expect(publish).toHaveBeenLastCalledWith([
      { width: 600, height: 800 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    ]);
  });

  test('cancellation discards late geometry from the previous PDF', async () => {
    let finish!: (value: PDFPageProxy) => void;
    const pending = new Promise<PDFPageProxy>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const publish = vi.fn();
    const loading = loadPageSizes(
      { numPages: 1, getPage: () => pending },
      publish,
      controller.signal,
    );
    controller.abort();
    finish(page());
    await loading;
    expect(publish).not.toHaveBeenCalled();
  });

  test('a later page failure retains the already published reading surface', async () => {
    const publish = vi.fn();
    await expect(
      loadPageSizes(
        {
          numPages: 2,
          getPage: async (number) => {
            if (number === 2) throw new Error('Damaged later page');
            return page();
          },
        },
        publish,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Damaged later page');
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toHaveLength(2);
  });
});
