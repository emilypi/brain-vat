import { test, expect } from './fixtures';
import { makePdfFixture, makeScrollingPdfFixture } from '../fixtures/pdf-fixtures';

test('browse and filter nested PDF contents without obscuring the paper', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'outline.pdf',
    mimeType: 'application/pdf',
    buffer: makeScrollingPdfFixture(),
  });
  const library = page.getByRole('button', { name: 'Library', exact: true });
  const contents = page.getByRole('region', { name: 'Table of contents' });
  await expect(contents).toBeHidden();
  await library.click();
  await expect(contents.getByRole('button', { name: 'Introduction 1' })).toBeVisible();
  const search = contents.getByRole('searchbox', { name: 'Find a section' });
  await expect(page.getByRole('navigation', { name: 'Library' })).toBeFocused();
  await search.fill('proof');
  await expect(contents.getByRole('button', { name: 'Conclusion 12' })).toHaveCount(0);
  await contents.getByRole('button', { name: 'Proof details 9' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('9');
  await expect(contents).toBeHidden();
  await library.click();
  await expect(
    contents.getByRole('button', { name: 'Proof details 9' }),
  ).toHaveAttribute('aria-current', 'location');
  await search.fill('');
  await page.screenshot({ path: 'test-results/pdf-contents.png' });
  await contents.getByRole('button', { name: 'Conclusion 12' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('12');
});

test('explain when the PDF does not contain an outline', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'without-outline.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture(),
  });
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(
    page.getByText('This PDF has no embedded table of contents.'),
  ).toBeVisible();
});
