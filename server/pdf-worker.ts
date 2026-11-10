import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_TEXT = 2_000_000;

async function extract(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error('PDF too large');
    chunks.push(bytes);
  }
  const task = getDocument({
    data: new Uint8Array(Buffer.concat(chunks)),
    useWasm: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) {
      throw new Error('Unsupported page count');
    }
    const pages: { pageIndex: number; text: string }[] = [];
    let textLength = 0;
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      textLength += text.length;
      if (textLength > MAX_TEXT) throw new Error('PDF text too large');
      pages.push({ pageIndex, text });
      page.cleanup();
    }
    process.stdout.write(JSON.stringify(pages));
  } finally {
    await task.destroy();
  }
}

extract().catch(() => {
  process.exitCode = 1;
});
