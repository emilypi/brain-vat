import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function openExample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
}

async function selectTitle(page: Page): Promise<void> {
  const text = page
    .locator('.textLayer span')
    .filter({
      hasText: 'Vectorizing Recurrences over Semirings',
    })
    .first();
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error('PDF title has no text bounds.');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Save highlight' })).toBeVisible();
}

test('text anchors survive zoom, rotation and reopening the PDF', async ({ page }) => {
  await openExample(page);
  await selectTitle(page);
  await page.getByRole('button', { name: 'Save highlight' }).click();
  const polygon = page.getByTestId('saved-highlight').first();
  await expect(polygon).toBeVisible();
  const before = await polygon.boundingBox();
  if (!before) throw new Error('Missing saved highlight.');
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  const zoomed = await polygon.boundingBox();
  expect(zoomed?.width).toBeCloseTo(before.width * (1.2 / 1.05), 0);
  const pageBeforeRotation = await page.getByTestId('pdf-page').boundingBox();
  await page.getByRole('button', { name: 'Rotate page' }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  const rotated = await polygon.boundingBox();
  const pageAfterRotation = await page.getByTestId('pdf-page').boundingBox();
  if (!pageBeforeRotation || !pageAfterRotation || !zoomed || !rotated) {
    throw new Error('Missing rotated page or highlight.');
  }
  // Rotation refits the page; the anchor must retain its normalized position.
  expect(rotated.height / pageAfterRotation.height).toBeCloseTo(
    zoomed.width / pageBeforeRotation.width,
    3,
  );
  await page.reload();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(polygon).toBeVisible();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete highlight' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/reader-prototype.png' });
  await page.getByRole('button', { name: 'Delete highlight' }).click();
  await expect(polygon).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(polygon).toHaveCount(0);
});

test('region capture saves independently of selectable text', async ({ page }) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  const bounds = await page.getByTestId('region-layer').boundingBox();
  if (!bounds) throw new Error('Missing region surface.');
  await page.mouse.move(bounds.x + 90, bounds.y + 90);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 160, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByText('Selected equation or figure region')).toBeVisible();
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByRole('status')).toHaveText('Highlight saved on this device.');
  await page.reload();
  await expect(page.getByTestId('saved-highlight')).toBeVisible();
  const saved = await page.getByTestId('saved-highlight').boundingBox();
  expect(saved?.width).toBeCloseTo(210, 0);
  expect(saved?.height).toBeCloseTo(70, 0);
});

test('evidence is labeled and sources return to the cited page', async ({ page }) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Where is semiring defined?' }).click();
  await expect(page.getByText('MATCHING PASSAGES')).toBeVisible();
  await expect(page.locator('.evidence-origin')).toHaveCount(3);
  const citation = page.locator('.citation').last();
  const label = await citation.innerText();
  const pageNumber = label.match(/\d+/)?.[0];
  await citation.click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(
    pageNumber ?? '',
  );
  await expect(page.getByText('Passage search', { exact: true })).toBeVisible();
});

test('local upload deduplicates by bytes and rejects a mislabeled file', async ({
  page,
}) => {
  await openExample(page);
  await page.getByTestId('pdf-upload').setInputFiles('public/samples/2611.02451v1.pdf');
  await expect(page.locator('.library-paper')).toHaveCount(1);
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'not-a-paper.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html>'),
  });
  await expect(page.getByRole('alert')).toContainText('This file is not a PDF.');
});
