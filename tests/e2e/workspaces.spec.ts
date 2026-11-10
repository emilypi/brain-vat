import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../server/app';
import type { AiProvider } from '../../src/workspace-contract';

let app: FastifyInstance;
let directory: string;
let calls = 0;
const origin = 'http://127.0.0.1:8791';
const provider: AiProvider = {
  name: 'Browser test provider',
  model: 'test-fixture',
  configured: true,
  generate: async (input) => {
    calls += 1;
    return {
      blocks: [
        {
          heading: 'Test explanation',
          text: 'A semiring supports addition and multiplication.',
          evidenceIds: ['paper-0'],
        },
      ],
      evidence: [
        {
          id: 'paper-0',
          origin: 'thisPaper',
          title: input.title,
          excerpt: input.pages[0]?.text.slice(0, 200) ?? '',
          pageIndex: 0,
          url: null,
          availability: 'excerpt',
        },
      ],
      model: 'test-fixture',
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  },
};

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brain-vat-browser-'));
  app = await createApp({
    dbPath: join(directory, 'test.sqlite'),
    provider,
    allowedOrigins: ['http://127.0.0.1:5173'],
  });
  await app.listen({ host: '127.0.0.1', port: 8791 });
});

test.afterAll(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function configure(context: BrowserContext): Promise<void> {
  await context.addInitScript((baseUrl) => {
    if (!localStorage.getItem('brain-vat-service')) {
      localStorage.setItem(
        'brain-vat-service',
        JSON.stringify({
          baseUrl,
          session: null,
        }),
      );
    }
  }, origin);
}

async function createAccount(page: Page, name: string): Promise<void> {
  const signUp = page.getByRole('button', { name: 'Create an account', exact: true });
  if (await signUp.isVisible()) await signUp.click();
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill('A-private-test-password-42');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
}

test('invited readers share notes, highlights and one AI conversation', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90_000);
  await configure(context);
  await page.goto('/');
  await page.getByRole('button', { name: 'Read the example paper' }).click();
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await createAccount(page, 'owner');
  await page.getByRole('button', { name: 'Upload paper and create room' }).click();
  await expect(page.locator('.workspace-dialog')).toHaveCount(0);
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.room-inspector > summary').click();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page
    .getByLabel('Single-use invitation', { exact: false })
    .inputValue();
  const invitedContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await configure(invitedContext);
  const invited = await invitedContext.newPage();
  await invited.goto('/' + new URL(link).hash);
  await createAccount(invited, 'reader');
  await invited.locator('.rooms-list .library-paper').first().click();
  await expect(invited.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await invited.getByRole('button', { name: 'Library', exact: true }).click();
  await invited.locator('.room-inspector > summary').click();

  const ownerNotes = page.getByRole('textbox', { name: 'Shared notes' });
  const readerNotes = invited.getByRole('textbox', { name: 'Shared notes' });
  await ownerNotes.fill('First shared observation.');
  await expect(readerNotes).toHaveValue('First shared observation.');
  await readerNotes.fill('First shared observation. Another perspective.');
  await expect(ownerNotes).toHaveValue(
    'First shared observation. Another perspective.',
  );

  await page.getByRole('button', { name: 'Collapse library' }).click();
  await invited.getByRole('button', { name: 'Collapse library' }).click();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await invited.getByRole('button', { name: 'Toggle reading companion' }).click();
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Region', exact: true }).click();
  const bounds = await page.getByTestId('region-layer').boundingBox();
  if (!bounds) throw new Error('Missing region layer.');
  await page.mouse.move(bounds.x + 80, bounds.y + 60);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 260, bounds.y + 110, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save highlight' }).click();
  await expect(invited.getByTestId('saved-highlight')).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Ask about this paper' })
    .fill('What is a semiring?');
  await page.getByRole('textbox', { name: 'Ask about this paper' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Ask about this paper' })).toHaveValue(
    '',
  );
  await expect(
    invited.getByText('A semiring supports addition and multiplication.'),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(
    page.getByText('A semiring supports addition and multiplication.'),
  ).toBeVisible();
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Reading options' }).click();
  await page.getByRole('button', { name: 'Enhanced reading', exact: true }).click();
  await expect(page.locator('.enhanced-reader')).toBeVisible();

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.locator('.room-inspector > summary').click();
  await page.getByRole('button', { name: 'Remove reader', exact: true }).click();
  await expect(invited.getByTestId('pdf-page')).toHaveCount(0);
  await expect(
    invited.getByText('A semiring supports addition and multiplication.'),
  ).toHaveCount(0);
  await invitedContext.close();
});
