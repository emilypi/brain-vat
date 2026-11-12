import { test, expect } from './fixtures';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

test('the example is readable while later pages are still loading', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    const waiting: (() => void)[] = [];
    let released = false;
    let firstPageTextRequests = 0;
    Worker.prototype.postMessage = function (
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ): void {
      const send = () => Reflect.apply(original, this, [message, options]);
      if (
        !released &&
        message &&
        typeof message === 'object' &&
        'action' in message &&
        'data' in message &&
        message.data &&
        typeof message.data === 'object' &&
        'pageIndex' in message.data &&
        typeof message.data.pageIndex === 'number'
      ) {
        if (message.action === 'GetTextContent' && message.data.pageIndex === 0) {
          firstPageTextRequests += 1;
          if (firstPageTextRequests === 2) {
            // One extraction builds the text layer; the next indexes the paper.
            const first = document.querySelector('.pdf-page[data-page-index="0"]');
            document.documentElement.dataset.readyBeforeIndex = String(
              first?.getAttribute('data-ready') === 'true',
            );
          }
        }
        if (message.action === 'GetPage' && message.data.pageIndex > 0) {
          waiting.push(send);
          document.documentElement.dataset.laterPagesPaused = 'true';
          return;
        }
      }
      send();
    };
    window.addEventListener('release-pdf-pages', () => {
      released = true;
      for (const send of waiting.splice(0)) send();
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-later-pages-paused', 'true');
  const first = page.locator('.pdf-page[data-page-index="0"]');
  await expect(first).toHaveAttribute('data-ready', 'true', { timeout: 5000 });
  await expect(first.locator('.textLayer')).toContainText(
    'Vectorizing Recurrences over Semirings',
  );
  await expect(page.getByText('Opening your paper…', { exact: true })).toBeHidden();
  await expect(page.locator('.pdf-page-slot')).toHaveCount(36);
  await expect(page.locator('html')).toHaveAttribute('data-ready-before-index', 'true');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(first).toHaveAttribute('data-ready', 'true');
  await page.screenshot({ path: 'test-results/first-page-before-later-pages.png' });

  await page.evaluate(() => window.dispatchEvent(new Event('release-pdf-pages')));
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.pdf-page[data-active="true"]')).toHaveAttribute(
    'data-page-index',
    '1',
  );
  await expect(page.locator('.pdf-page[data-active="true"]')).toHaveAttribute(
    'data-ready',
    'true',
  );
});

test('enhanced reading works before the PDF canvas finishes rendering', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ): void {
      if (
        message &&
        typeof message === 'object' &&
        'action' in message &&
        message.action === 'GetOperatorList'
      ) {
        document.documentElement.dataset.canvasPaused = 'true';
        return;
      }
      Reflect.apply(original, this, [message, options]);
    };
  });
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'slow-canvas.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture(),
  });
  await expect(page.locator('html')).toHaveAttribute('data-canvas-paused', 'true');
  await expect(
    page.getByRole('button', { name: 'Zoom in', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Enhanced reading', exact: true }).click();
  await expect(page.locator('.extracted-pages')).toContainText('Rotated crop evidence');
});
