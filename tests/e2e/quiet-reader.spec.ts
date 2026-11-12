import { test, expect } from './fixtures';

for (const width of [1440, 1280, 800, 320]) {
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

test('Ask moves smoothly while the PDF keeps its canvas and reading position', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  const paper = page.locator('.pdf-page[data-active="true"]');
  await expect(paper).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(paper).toHaveAttribute('data-ready', 'true');
  const motion = await page.evaluate(async () => {
    const drawer = document.querySelector<HTMLElement>('#reading-companion')!;
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.pdf-page[data-active="true"] canvas',
    )!;
    const stage = document.querySelector<HTMLElement>('.page-stage')!;
    const toggle = document.querySelector<HTMLButtonElement>('.companion-toggle')!;
    const initialTop = stage.scrollTop;
    let redraws = 0;
    const observer = new MutationObserver((changes) => {
      redraws += changes.length;
    });
    observer.observe(canvas, {
      attributes: true,
      attributeFilter: ['width', 'height'],
    });
    const positions = new Set<number>();
    toggle.click();
    await new Promise<void>((resolve) => {
      const sample = (): void => {
        positions.add(Math.round(drawer.getBoundingClientRect().x));
        if (drawer.getAnimations().some((item) => item.playState === 'running')) {
          requestAnimationFrame(sample);
        } else resolve();
      };
      requestAnimationFrame(sample);
    });
    observer.disconnect();
    return {
      positions: positions.size,
      redraws,
      scrollShift: Math.abs(stage.scrollTop - initialTop),
    };
  });
  expect(motion.positions).toBeGreaterThan(2);
  expect(motion.redraws).toBe(0);
  expect(motion.scrollShift).toBeLessThan(1);

  const question = page.getByRole('textbox', { name: 'Search this paper' });
  await question.fill('Keep my draft');
  await question.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Toggle reading companion' }),
  ).toBeFocused();
  await expect(page.getByRole('complementary')).toBeHidden();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(question).toHaveValue('Keep my draft');
});

test('reduced motion opens and closes Ask immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Toggle reading companion' });
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  await toggle.click();
  await expect(page.getByRole('complementary')).toBeVisible();
  expect(
    await page.locator('.reader-app').evaluate((element) => {
      const drawer = element.querySelector('#reading-companion')!;
      return [...element.getAnimations(), ...drawer.getAnimations()].filter(
        (item) => item.playState === 'running',
      ).length;
    }),
  ).toBe(0);
  await page.getByRole('button', { name: 'Close reading companion' }).click();
  await expect(page.getByRole('complementary')).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('the companion resizes with pointer and keyboard while keeping the page', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  const active = page.locator('.pdf-page[data-active="true"]');
  await expect(active).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  const divider = page.getByRole('separator', { name: 'Resize reading companion' });
  await divider.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '440');
  await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '420');
  await divider.click({ trial: true });
  const bounds = await divider.boundingBox();
  if (!bounds) throw new Error('Missing panel divider');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 300);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 140, bounds.y + 300);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '560');
  await expect(page.locator('.companion-drawer')).toHaveCSS('width', '560px');
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('2');
  await expect(active).toHaveAttribute('data-ready', 'true');
  await divider.press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', '420');
  await expect(
    page.getByRole('button', { name: 'Zoom in', exact: true }),
  ).toBeVisible();
});
