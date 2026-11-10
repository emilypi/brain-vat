import { test, expect } from './fixtures';

for (const width of [1440, 800, 320]) {
  test(`reading stays unobstructed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Read the example paper' }).click();
    const paper = page.locator('.pdf-page[data-active="true"]');
    await expect(paper).toHaveAttribute('data-ready', 'true');
    await expect(page.getByRole('navigation', { name: 'Library' })).toBeHidden();
    await expect(page.getByRole('complementary')).toBeHidden();
    const bounds = await paper.boundingBox();
    if (!bounds) throw new Error('The paper must be visible.');
    expect(bounds.y).toBeLessThan(25);
    expect(bounds.x).toBeGreaterThanOrEqual(44);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (width === 1440) expect(bounds.width).toBeGreaterThanOrEqual(800);

    const library = page.getByRole('button', { name: 'Library', exact: true });
    await library.click();
    await page.getByRole('searchbox', { name: 'Find a paper' }).fill('not in library');
    await expect(page.getByText('No papers match your search.')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find a paper' }).fill('Semirings');
    await expect(page.locator('#reader-library .library-paper')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find a paper' }).press('Escape');
    await expect(library).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'Library' })).toBeHidden();

    await page.getByRole('button', { name: 'Toggle reading companion' }).click();
    const question = page.getByRole('textbox', { name: 'Search this paper' });
    await question.fill('Explain a semiring');
    await page.getByRole('button', { name: 'Close reading companion' }).click();
    await page.getByRole('button', { name: 'Toggle reading companion' }).click();
    await expect(question).toHaveValue('Explain a semiring');
    await page.getByRole('button', { name: 'Close reading companion' }).click();

    await page.getByRole('button', { name: 'Reading options' }).click();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await page.getByRole('button', { name: 'Rotate page' }).press('Escape');
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset zoom to fit' })).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByRole('spinbutton')).toHaveValue('2');
    await expect(paper).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(paper).toHaveAttribute('data-ready', 'true');

    for (const theme of ['light', 'dark']) {
      const toggle = page.getByRole('button', { name: `Switch to ${theme} mode` });
      if (await toggle.isVisible()) await toggle.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(paper).toHaveAttribute('data-ready', 'true');
      await page.screenshot({
        path: `test-results/quiet-reader-${theme}-${width}.png`,
      });
    }
  });
}
