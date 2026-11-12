import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

async function openPaper(page: Page, imageOnly = false): Promise<void> {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'precision.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture({ columns: true, imageOnly }),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Highlight tool' }).click();
}

test('snap to one column, refine words, and preserve a highlight across zoom', async ({
  page,
}) => {
  await openPaper(page);
  const first = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Alpha precise words' })
    .boundingBox();
  const second = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Second selected line' })
    .boundingBox();
  if (!first || !second) throw Error('Missing fixture text');
  await page.mouse.move(first.x - 4, first.y - 3);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width + 4, second.y + second.height + 3, {
    steps: 8,
  });
  await expect(page.locator('.selection-magnifier')).toBeVisible();
  await expect(page.locator('.snapped-word')).toHaveCount(6);
  await expect(
    page.getByRole('complementary', { name: 'Reading companion' }),
  ).toBeHidden();
  await page.screenshot({ path: 'test-results/precision-magnifier.png' });
  await page.mouse.up();
  await expect(page.getByText('6 words selected', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/precision-selection.png' });
  await expect(
    page.getByRole('complementary', { name: 'Reading companion' }),
  ).toBeVisible();
  await expect(page.locator('.selection-quote')).toHaveText(
    'Alpha precise words Second selected line',
  );
  await page.getByRole('button', { name: 'Close reading companion' }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.getByRole('complementary', { name: 'Reading companion' }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Resize selection right', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(6);
  await expect(page.locator('.precision-box')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(6);
});

test('click a word, then use resize handles and keyboard nudges', async ({ page }) => {
  await openPaper(page);
  const text = page
    .locator('.textLayer span')
    .filter({ hasText: 'Alpha precise words' });
  const word = await text.evaluate((element) => {
    const node = element.firstChild!;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 13);
    const box = range.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
  await expect(page.getByTestId('selected-highlight')).toHaveCount(1);
  await expect(page.locator('.selection-quote')).toHaveText('precise');
  await expect(page.locator('.selection-quote')).toBeVisible();
  const handle = page.getByRole('button', {
    name: 'Resize selection right',
    exact: true,
  });
  for (let count = 0; count < 6; count += 1) await handle.press('Shift+ArrowRight');
  await expect(page.getByTestId('selected-highlight')).toHaveCount(2);
  await expect(page.locator('.selection-quote')).toHaveText('precise words');
  const before = await page.locator('.precision-box').boundingBox();
  await page.getByRole('button', { name: 'Move selection box' }).press('ArrowDown');
  const after = await page.locator('.precision-box').boundingBox();
  expect(after!.y - before!.y).toBeCloseTo(1, 0);
  await page.getByRole('button', { name: 'Move selection box' }).press('Escape');
  await expect(page.getByTestId('selected-highlight')).toHaveCount(0);
});

test('select text precisely on an intrinsically rotated, cropped PDF', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'rotated-selection.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture({ columns: true, cropped: true, rotated: true }),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  const text = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Alpha precise words' })
    .boundingBox();
  if (!text) throw Error('Missing rotated text');
  await page.mouse.move(text.x - 3, text.y - 3);
  await page.mouse.down();
  await page.mouse.move(text.x + text.width + 3, text.y + text.height + 3);
  await page.mouse.up();
  await expect(page.getByTestId('selected-highlight')).toHaveCount(3);
  await expect(page.locator('.selection-quote')).toHaveText('Alpha precise words');
  await expect(page.locator('.selection-quote')).toBeVisible();
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(3);
  await page.reload();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(3);
});

test('Escape cancels a drawing without creating a highlight', async ({ page }) => {
  await openPaper(page);
  const bounds = await page.getByTestId('region-layer').boundingBox();
  if (!bounds) throw Error('Missing selection surface');
  await page.mouse.move(bounds.x + 100, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 300);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.selection-magnifier')).toHaveCount(0);
  await expect(page.locator('.precision-box')).toHaveCount(0);
  await expect(page.getByTestId('selected-highlight')).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Reading companion' }),
  ).toBeHidden();
});

test('adjust scanned-page areas and retain the box after rotation', async ({
  page,
}) => {
  await openPaper(page, true);
  const surface = page.getByTestId('region-layer');
  const bounds = await surface.boundingBox();
  if (!bounds) throw Error('Missing selection surface');
  await page.mouse.move(bounds.x + 90, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 230, bounds.y + 350);
  await page.mouse.up();
  await expect(page.getByText('No text here.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save highlight' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Area', exact: true }).click();
  await page.mouse.move(bounds.x + 90, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 230, bounds.y + 350);
  await page.mouse.up();
  const preview = page.getByRole('img', { name: 'Selected region from page 1' });
  await expect(preview).toBeVisible();
  const originalPreview = await preview.getAttribute('src');
  const handle = page.getByRole('button', { name: 'Resize selection bottom right' });
  // Selecting the area opens Ask; wait before measuring the moving handle.
  await handle.click({ trial: true });
  const point = await handle.boundingBox();
  if (!point) throw Error('Missing resize handle');
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x + 50, point.y + 35);
  await page.mouse.up();
  await expect(preview).toBeVisible();
  await expect(preview).not.toHaveAttribute('src', originalPreview!);
  const before = await page.locator('.precision-box').boundingBox();
  expect(before!.width).toBeGreaterThan(170);
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Rotate page' }).click();
  await page.getByRole('button', { name: 'Rotate page' }).press('Escape');
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(handle).toBeVisible();
  await handle.press('ArrowDown');
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('saved-highlight')).toHaveCount(1);
});
