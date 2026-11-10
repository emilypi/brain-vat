import { test, expect } from './fixtures';
import { makeScrollingPdfFixture } from '../fixtures/pdf-fixtures';

test('scrolling, links and zoom retain the reading position across pages', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'continuous-reading.pdf',
    mimeType: 'application/pdf',
    buffer: makeScrollingPdfFixture(),
  });
  const active = page.locator('.pdf-page[data-active="true"]');
  await expect(active).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.pdf-page-slot')).toHaveCount(12);
  expect(await page.locator('.pdf-page canvas').count()).toBeLessThan(8);
  const counter = page.getByRole('spinbutton', { name: 'Page number' });
  const stage = page.locator('.continuous-pages');
  await stage.hover();
  await page.mouse.wheel(0, 760);
  await expect(counter).toHaveValue('2');
  await expect(active).toHaveAttribute('data-ready', 'true');
  await page.screenshot({ path: 'test-results/continuous-reading.png' });

  await counter.fill('9');
  await expect(active).toHaveAttribute('data-page-index', '8');
  await expect(active).toHaveAttribute('data-ready', 'true');
  expect(await page.locator('.pdf-page canvas').count()).toBeLessThan(8);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(active).toHaveAttribute('data-ready', 'true');
  await expect(counter).toHaveValue('9');
  await page.getByRole('button', { name: 'Reset zoom to fit' }).click();
  await expect(counter).toHaveValue('9');

  await counter.fill('1');
  await expect(active).toHaveAttribute('data-page-index', '0');
  const source = active.locator('.pdf-source button').first();
  await source.hover();
  await expect(active.getByRole('tooltip')).toContainText('This paper · page 12');
  await expect(source).toHaveCSS('border-bottom-style', 'solid');
  await expect(source).toHaveCSS('border-bottom-width', '2px');
  await source.click();
  await expect(counter).toHaveValue('12');
  await expect(active).toHaveAttribute('data-page-index', '11');
  await expect(active).toHaveAttribute('data-ready', 'true');

  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  const prompt = page.getByRole('textbox', { name: 'Search this paper' });
  await prompt.fill('supporting');
  await prompt.press('Shift+Enter');
  await expect(prompt).toHaveValue('supporting\n');
  await expect(page.getByText('MATCHING PASSAGES', { exact: true })).toHaveCount(0);
  await prompt.press('Enter');
  await expect(page.getByText('MATCHING PASSAGES', { exact: true })).toBeVisible();
});
