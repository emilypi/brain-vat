import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createApp } from '../../server/app';
import type { AiProvider, ProviderInput } from '../../src/workspace-contract';
import { LEAN_VERSION, MATHLIB_VERSION } from '../../src/proof';
import type { LeanChecker, ProofBreakdown } from '../../src/proof';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

const origin = 'http://127.0.0.1:8796';
const inputs: ProviderInput[] = [];
let app: FastifyInstance;
let checkCount = 0;
const proof: ProofBreakdown = {
  title: 'Equality is reflexive',
  claim: 'Each natural number equals itself.',
  interpretation: 'Interpret the selected claim as reflexivity.',
  summary: 'Introduce the number and use reflexivity.',
  assumptions: ['The value is a natural number.'],
  gaps: [],
  imports: [],
  statement: '∀ (n : Nat), n = n',
  steps: [
    {
      id: 'reflexivity',
      title: 'Use reflexivity',
      explanation: 'The two sides are the same number.',
      tactic: 'intro n\nrfl',
      evidenceIds: ['paper-0'],
      prerequisiteIds: [],
    },
  ],
  prerequisites: [],
};
const provider: AiProvider = {
  name: 'Test provider',
  model: 'test-astra',
  configured: true,
  generate: async (input) => {
    inputs.push(input);
    return {
      blocks: [
        {
          heading: 'An explanation',
          text: 'Remembered explanation: ' + input.question,
          evidenceIds: ['paper-0'],
        },
      ],
      evidence: [
        {
          id: 'paper-0',
          title: input.title,
          origin: 'thisPaper',
          excerpt: input.pages[0]!.text,
          pageIndex: 0,
          url: null,
          availability: 'excerpt',
        },
      ],
      ...(input.kind === 'proof' ? { proof } : {}),
      model: 'test-astra',
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  },
};
const checker: LeanChecker = {
  status: async () => ({
    available: true,
    leanVersion: LEAN_VERSION,
    mathlibVersion: MATHLIB_VERSION,
    message: 'Fixture checker ready.',
  }),
  check: async () => {
    checkCount += 1;
    return {
      status: 'checked',
      message: 'Reflexivity checked by the fixture.',
      diagnostics: [],
      axioms: [],
      steps: [
        {
          stepId: 'reflexivity',
          before: ['⊢ ∀ (n : Nat), n = n'],
          after: [],
        },
      ],
    };
  },
};

test.beforeAll(async () => {
  app = await createApp({
    dbPath: ':memory:',
    provider,
    leanChecker: checker,
    enableSolo: true,
    allowedOrigins: ['http://127.0.0.1:5173'],
  });
  await app.listen({ host: '127.0.0.1', port: 8796 });
});
test.afterAll(async () => {
  await app.close();
});
test.beforeEach(() => {
  inputs.length = 0;
  checkCount = 0;
  provider.configured = true;
});

async function setup(page: Page, context: BrowserContext): Promise<void> {
  await context.addInitScript((baseUrl) => {
    if (!localStorage.getItem('brain-vat-service'))
      localStorage.setItem(
        'brain-vat-service',
        JSON.stringify({ baseUrl, session: null }),
      );
  }, origin);
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'proof.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture({ columns: true }),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Ask about this paper' }),
  ).toBeVisible();
}

async function contextsMenu(page: Page): Promise<void> {
  const menu = page.locator('.saved-context-control');
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator('summary').click();
}

async function save(page: Page, name: string): Promise<void> {
  await contextsMenu(page);
  await page.getByRole('textbox', { name: 'Context name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save context', exact: true }).click();
  await expect(page.locator('.context-current')).toHaveText(name);
  await page
    .getByRole('textbox', { name: 'Context name', exact: true })
    .press('Escape');
  await expect(page.getByRole('complementary')).toBeVisible();
}

async function ask(page: Page, question: string): Promise<void> {
  const input = page.getByRole('textbox', {
    name: 'Ask about this paper',
    exact: true,
  });
  await expect(page.getByRole('button', { name: 'Send AI question' })).toBeDisabled();
  await input.fill(question);
  await expect(page.getByRole('button', { name: 'Send AI question' })).toBeEnabled();
  await input.press('Enter');
  await expect(page.getByText('Remembered explanation: ' + question)).toBeVisible();
}

test('named contexts update and reopen proof checks without running them again', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  const point = await page
    .locator('.textLayer span')
    .filter({ hasText: 'Alpha precise words' })
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 6);
      range.setEnd(element.firstChild!, 13);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
  await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toBeVisible();
  await save(page, 'Reflexivity study');
  await workspace.getByRole('button', { name: 'Break down current selection' }).click();
  await expect(
    workspace.getByRole('heading', { name: 'Equality is reflexive' }),
  ).toBeVisible();
  expect(inputs).toHaveLength(1);
  expect(checkCount).toBe(1);

  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await ask(page, 'How does this connect to the argument?');
  expect(inputs[1]?.rememberedProofs).toHaveLength(1);
  expect(inputs[1]?.rememberedProofs?.[0]?.verification.status).toBe('checked');
  provider.configured = false;
  await page.reload();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(page.locator('.context-current')).toHaveText('Reflexivity study');
  await expect(
    page.getByText('Remembered explanation: How does this connect to the argument?'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Proofs', exact: true }).click();
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toBeVisible();
  await workspace.getByText('Lean tactic and goals', { exact: true }).click();
  await expect(
    workspace.getByText('⊢ ∀ (n : Nat), n = n', { exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(checkCount).toBe(1);
  await page.screenshot({ path: 'test-results/saved-proof-context.png' });
});

test('contexts can be switched, renamed, deleted and stay bound to their PDF', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await ask(page, 'First reading');
  await save(page, 'First context');
  await contextsMenu(page);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.locator('.context-current')).toHaveText('Unsaved conversation');
  await page.locator('.saved-context-control summary').click();
  await ask(page, 'Second reading');
  await save(page, 'Second context');
  await contextsMenu(page);
  await page
    .getByRole('textbox', { name: 'Context name', exact: true })
    .fill('Revised');
  await page.getByRole('button', { name: 'Rename context', exact: true }).click();
  await expect(page.locator('.context-current')).toHaveText('Revised');
  await page.getByRole('combobox', { name: 'Saved contexts' }).selectOption({
    label: 'First context',
  });
  await expect(page.locator('.context-current')).toHaveText('First context');
  await page.locator('.saved-context-control summary').click();
  await expect(page.getByText('Remembered explanation: First reading')).toBeVisible();
  await expect(page.getByText('Remembered explanation: Second reading')).toHaveCount(0);
  await contextsMenu(page);
  await page.getByRole('button', { name: 'Delete context', exact: true }).click();
  await page.getByRole('button', { name: 'Delete saved context', exact: true }).click();
  await expect(page.locator('.context-current')).toHaveText('Unsaved conversation');
  await expect(
    page.getByRole('combobox', { name: 'Saved contexts' }).locator('option'),
  ).toHaveText(['Choose a context', 'Revised']);
  expect(inputs).toHaveLength(2);

  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'another.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture(),
  });
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await contextsMenu(page);
  await expect(
    page.getByRole('combobox', { name: 'Saved contexts' }).locator('option'),
  ).toHaveText(['Choose a context']);
  await expect(page.getByText('Remembered explanation: First reading')).toHaveCount(0);
});

test('two tabs see saved updates and deletion never creates a replacement', async ({
  page,
  context,
}) => {
  await setup(page, context);
  await save(page, 'Reading together');
  const second = await context.newPage();
  await second.goto(page.url());
  await second.getByRole('button', { name: 'Toggle reading companion' }).click();
  await expect(second.locator('.context-current')).toHaveText('Reading together');
  await expect(second.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  const secondQuestion = second.getByRole('textbox', { name: 'Ask about this paper' });
  await secondQuestion.fill('A question from the second tab');
  await expect(second.getByRole('button', { name: 'Send AI question' })).toBeEnabled();
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 500);
  await secondQuestion.press('Enter');
  await expect.poll(() => inputs.length).toBe(1);
  await contextsMenu(page);
  await page
    .getByRole('textbox', { name: 'Context name', exact: true })
    .fill('Shared revision');
  await page.getByRole('button', { name: 'Rename context', exact: true }).click();
  await expect(page.locator('.context-current')).toHaveText('Shared revision');
  await page.locator('.saved-context-control summary').click();
  await page.clock.runFor(1100);
  await page.clock.resume();
  await expect(
    page.getByText('Remembered explanation: A question from the second tab'),
  ).toBeVisible();
  await contextsMenu(page);
  await page.getByRole('button', { name: 'Delete context', exact: true }).click();
  await page.getByRole('button', { name: 'Delete saved context', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText(/expired|unavailable|deleted/i);
  await contextsMenu(second);
  await expect(
    second.getByRole('button', { name: 'Forget local reference' }),
  ).toBeVisible();
  await second
    .getByRole('textbox', { name: 'Ask about this paper' })
    .fill('Do not silently create a new context');
  await expect(second.getByRole('button', { name: 'Send AI question' })).toBeDisabled();
  expect(inputs).toHaveLength(1);
  await second.close();
});

test('the storage upgrade preserves existing PDFs and highlights', async ({ page }) => {
  const bytes = makePdfFixture();
  const documentId = createHash('sha256').update(bytes).digest('hex');
  await page.route('**/migration-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Storage fixture</title>',
    }),
  );
  await page.goto('/migration-fixture');
  await page.evaluate(
    async ({ documentId, bytes }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('paper-reader', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('papers', { keyPath: 'id' });
          db.createObjectStore('highlights', { keyPath: 'id' }).createIndex(
            'by-document',
            'anchor.documentId',
          );
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(['papers', 'highlights'], 'readwrite');
        tx.objectStore('papers').put({
          id: documentId,
          title: 'Existing paper',
          filename: 'existing.pdf',
          sourceUrl: null,
          bytes: new Uint8Array(bytes).buffer,
          addedAt: new Date().toISOString(),
          pageCount: 1,
        });
        tx.objectStore('highlights').put({
          id: crypto.randomUUID(),
          note: 'Keep this note',
          createdAt: new Date().toISOString(),
          anchor: {
            documentId,
            pageIndex: 0,
            kind: 'text',
            quote: 'Existing highlight',
            quads: [
              [
                { x: 0.1, y: 0.1 },
                { x: 0.3, y: 0.1 },
                { x: 0.3, y: 0.15 },
                { x: 0.1, y: 0.15 },
              ],
            ],
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    },
    { documentId, bytes: [...bytes] },
  );
  await page.goto('/#doc=' + documentId);
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('saved-highlight')).toHaveCount(1);
  const counts = await page.evaluate(async () => {
    const request = indexedDB.open('paper-reader', 2);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const count = (store: string): Promise<number> =>
      new Promise((resolve) => {
        const request = db.transaction(store).objectStore(store).count();
        request.onsuccess = () => resolve(request.result);
      });
    const result = await Promise.all([count('papers'), count('highlights')]);
    db.close();
    return result;
  });
  expect(counts).toEqual([1, 1]);
});
