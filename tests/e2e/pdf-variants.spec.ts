import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

async function upload(page: Page, buffer: Buffer): Promise<void> {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'fixture.pdf',
    mimeType: 'application/pdf',
    buffer,
  });
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
}

test('cropped and rotated PDF anchors retain their source links', async ({ page }) => {
  await upload(page, makePdfFixture({ cropped: true, rotated: true }));
  const surface = page.getByTestId('pdf-page');
  await expect(surface).toHaveAttribute('data-ready', 'true');
  const title = page
    .locator('.textLayer span')
    .filter({ hasText: 'Rotated crop evidence' });
  const initial = await title.boundingBox();
  if (!initial) throw new Error('The rotated title is not selectable.');
  await page.mouse.move(initial.x + initial.width / 2, initial.y + 1);
  await page.mouse.down();
  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height - 1, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.locator('.selection-quote')).toContainText('Rotated crop evidence');
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByRole('status')).toContainText('Highlight saved');
  const mark = page.getByTestId('saved-highlight').first();
  const saved = await mark.boundingBox();
  expect(saved?.height).toBeCloseTo(initial.height, 0);
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(surface).toHaveAttribute('data-ready', 'true');
  const zoomed = await mark.boundingBox();
  expect(zoomed?.height).toBeCloseTo(initial.height * (1.2 / 1.05), 0);
  await page.reload();
  await expect(surface).toHaveAttribute('data-ready', 'true');
  await expect(mark).toBeVisible();
  const restored = await mark.boundingBox();
  expect(restored?.height).toBeCloseTo(initial.height, 0);

  const link = page.locator('.pdf-source a').first();
  await expect(link).toHaveAttribute('href', 'https://example.org/evidence');
  await link.hover();
  await expect(
    page.getByRole('tooltip').filter({ hasText: 'content not retrieved' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Hide source links' }).click();
  await expect(page.locator('.pdf-source')).toHaveCount(0);
  await expect(title).toBeVisible();
});

test('image-only PDFs retain region capture without inventing selectable text', async ({
  page,
}) => {
  await upload(page, makePdfFixture({ imageOnly: true }));
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.textLayer span')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  const region = await page.getByTestId('region-layer').boundingBox();
  if (!region) throw new Error('Missing region surface.');
  await page.mouse.move(region.x + 100, region.y + 180);
  await page.mouse.down();
  await page.mouse.move(region.x + 260, region.y + 280, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByRole('status')).toContainText('Highlight saved');
  await page.reload();
  await expect(page.getByTestId('saved-highlight')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await page.getByRole('textbox', { name: 'Search this paper' }).fill('visible figure');
  await page.getByRole('button', { name: 'Find supporting passages' }).click();
  await expect(
    page.getByText('No matching text found.', { exact: false }),
  ).toBeVisible();
});

test('malformed and password-protected PDFs report explicit failures', async ({
  page,
}) => {
  await upload(page, Buffer.from('%PDF-1.4\nnot a valid document\n'));
  await expect(page.getByRole('alert')).toContainText('Invalid PDF');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'encrypted.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture({ encrypted: true }),
  });
  await expect(page.getByRole('alert')).toContainText(/password/i);
  await expect(page.locator('.textLayer span')).toHaveCount(0);
});
