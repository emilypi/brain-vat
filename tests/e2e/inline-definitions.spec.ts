import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../server/app';
import type { AiProvider, ProviderInput } from '../../src/workspace-contract';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

const origin = 'http://127.0.0.1:8794';
const inputs: ProviderInput[] = [];
let app: FastifyInstance;
const provider: AiProvider = {
  name: 'Test provider',
  model: 'test-astra',
  configured: true,
  generate: async (input) => {
    inputs.push(input);
    const outside = Boolean(input.externalQuery);
    return {
      blocks: [
        {
          heading: outside ? 'Outside definition' : 'Meaning in this paper',
          text: outside
            ? 'An external definition with evidence.'
            : `A contextual explanation of ${input.selection?.quote}.`,
          evidenceIds: ['source'],
        },
      ],
      evidence: [
        {
          id: 'source',
          title: outside ? 'A reference source' : input.title,
          origin: outside ? 'externalSource' : 'thisPaper',
          excerpt: outside ? 'Retrieved external evidence.' : input.pages[0]!.text,
          pageIndex: outside ? null : 0,
          url: outside ? 'https://example.org/definition' : null,
          availability: 'excerpt',
        },
      ],
      model: 'test-astra',
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  },
};

test.beforeAll(async () => {
  app = await createApp({
    dbPath: ':memory:',
    provider,
    enableSolo: true,
    allowedOrigins: ['http://127.0.0.1:5173'],
  });
  await app.listen({ host: '127.0.0.1', port: 8794 });
});
test.afterAll(async () => {
  await app.close();
});
test.beforeEach(() => {
  inputs.length = 0;
});

async function openPaper(page: Page, context: BrowserContext): Promise<void> {
  await context.addInitScript((baseUrl) => {
    if (!localStorage.getItem('brain-vat-service'))
      localStorage.setItem(
        'brain-vat-service',
        JSON.stringify({
          baseUrl,
          session: null,
        }),
      );
  }, origin);
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'definitions.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture({ columns: true }),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
}

async function selectWord(page: Page, start = 6, end = 13): Promise<void> {
  const word = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Alpha precise words' })
    .evaluate(
      (element, offsets) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, offsets.start);
        range.setEnd(element.firstChild!, offsets.end);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      },
      { start, end },
    );
  await page.mouse.click(word.x, word.y);
  await expect(page.getByTestId('selected-highlight')).toHaveCount(1);
}

test('inline definitions preserve reading, label origins and reuse answers', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  await selectWord(page);
  await page.getByRole('button', { name: 'Close reading companion' }).click();
  expect(inputs).toHaveLength(0);
  await page.getByRole('button', { name: 'Define selected text' }).click();
  const card = page.getByRole('dialog', { name: 'precise', exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText('A contextual explanation of precise.')).toBeVisible();
  await expect(card.locator('.definition-origins')).toHaveText('This paper');
  await expect(page.locator('.companion-drawer')).toBeHidden();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.kind).toBe('definition');
  expect(inputs[0]?.externalQuery).toBeNull();
  await card.getByText('Sources (1)').click();
  await expect(card.getByRole('button', { name: 'Page 1' })).toBeVisible();
  await page.screenshot({ path: 'test-results/inline-definition-light.png' });
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('selected-highlight')).toHaveCount(1);
  await page.getByRole('button', { name: 'Define selected text' }).click();
  await expect(card.getByText('A contextual explanation of precise.')).toBeVisible();
  expect(inputs).toHaveLength(1);

  await card.getByRole('button', { name: 'Outside sources' }).click();
  expect(inputs).toHaveLength(1);
  await card.getByLabel('Search terms').fill('precise mathematical meaning');
  await card.getByLabel('Search terms').press('Enter');
  await expect(card.getByText('An external definition with evidence.')).toBeVisible();
  await expect(card.locator('.definition-origins')).toHaveText('External source');
  expect(inputs).toHaveLength(2);
  expect(inputs[1]?.externalQuery).toBe('precise mathematical meaning');
  expect(inputs[1]?.selection?.quote).toBe('precise');
  await card.getByText('Sources (1)').click();
  await expect(card.getByRole('link', { name: 'Open source' })).toHaveAttribute(
    'href',
    'https://example.org/definition',
  );
  await card.getByRole('button', { name: 'Look up' }).click();
  expect(inputs).toHaveLength(2);
  await card.getByRole('button', { name: 'In this paper' }).click();
  await expect(card.getByText('A contextual explanation of precise.')).toBeVisible();
  await card.getByRole('button', { name: 'Page 1' }).click();
  await expect(card).toHaveCount(0);

  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.getByRole('button', { name: 'Define selected text' }).click();
  await expect(card.getByText('A contextual explanation of precise.')).toBeVisible();
  await page.screenshot({ path: 'test-results/inline-definition-dark.png' });
  const before = await card.boundingBox();
  await page.locator('.continuous-pages').evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect.poll(async () => (await card.boundingBox())?.y).toBeLessThan(before!.y);
  await page.locator('.continuous-pages').evaluate((element) => {
    element.scrollTop = 500;
  });
  await expect(card).toBeHidden();
  await page.locator('.continuous-pages').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(card).toBeVisible();
  await page.setViewportSize({ width: 850, height: 600 });
  await expect(card).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await card.boundingBox();
      return (
        bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 850 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 600
      );
    })
    .toBe(true);
  expect(inputs).toHaveLength(2);
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(card).toHaveCount(0);
  await expect(
    page
      .locator('.companion-drawer')
      .getByText('An external definition with evidence.'),
  ).toBeVisible();
});

test('retry preserves identity and a changed term gets a new answer', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  let dropResponse = true;
  const requestIds: string[] = [];
  await page.route(origin + '/api/solo/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requestIds.push(
      (route.request().postDataJSON() as { requestId: string }).requestId,
    );
    const response = await route.fetch();
    if (dropResponse) {
      dropResponse = false;
      await route.fulfill({ status: 503, json: { error: 'Delivery interrupted.' } });
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  await selectWord(page);
  await page.getByRole('button', { name: 'Define selected text' }).click();
  const card = page.getByRole('dialog', { name: 'precise', exact: true });
  await expect(card.getByRole('button', { name: 'Retry delivery' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Define selected text' }).click();
  await card.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(card.getByText('A contextual explanation of precise.')).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  expect(inputs).toHaveLength(1);
  await selectWord(page, 0, 5);
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Define selected text' }).click();
  const next = page.getByRole('dialog', { name: 'Alpha', exact: true });
  await expect(next.getByText('A contextual explanation of Alpha.')).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(inputs[1]?.selection?.quote).toBe('Alpha');
});

test('shared inline answers remain in the room conversation after a reload', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('definition-reader');
  await page.getByLabel('Password', { exact: true }).fill('A-private-test-password-42');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await page.getByRole('button', { name: 'Upload paper and create room' }).click();
  await expect(page.locator('.workspace-dialog')).toHaveCount(0);
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  await selectWord(page);
  await page.getByRole('button', { name: 'Define selected text' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'precise', exact: true })
      .getByText('A contextual explanation of precise.'),
  ).toBeVisible();
  expect(inputs).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.locator('.rooms-list .library-paper').first().click();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(
    page.locator('.companion-drawer').getByText('A contextual explanation of precise.'),
  ).toBeVisible();
  expect(inputs).toHaveLength(1);
});

test('native selections support keyboard definitions without AI', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'native.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture(),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page
    .locator('.textLayer span')
    .filter({ hasText: 'Rotated crop evidence' })
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 13);
      range.setEnd(element.firstChild!, 21);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  const trigger = page.getByRole('button', { name: 'Define selected text' });
  await trigger.focus();
  await trigger.press('Enter');
  const card = page.getByRole('dialog', { name: 'evidence', exact: true });
  await expect(card).toBeVisible();
  await expect(
    card.getByText('Definitions need a configured Astra service.', { exact: false }),
  ).toBeVisible();
  await expect(card).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(inputs).toHaveLength(0);
});
