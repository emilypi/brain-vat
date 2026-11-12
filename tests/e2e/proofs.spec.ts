import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../server/app';
import type { AiProvider, ProviderInput } from '../../src/workspace-contract';
import type { LeanChecker, ProofBreakdown } from '../../src/proof';
import { LEAN_VERSION, MATHLIB_VERSION } from '../../src/proof';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

const origin = 'http://127.0.0.1:8795';
const inputs: ProviderInput[] = [];
let app: FastifyInstance;
let waitForCancel = false;

function proofFor(input: ProviderInput): ProofBreakdown {
  const title =
    input.proofContext?.prerequisite?.title ??
    (input.proofContext
      ? 'Background explanation'
      : input.image
        ? 'A diagram argument'
        : 'Conjunction symmetry');
  return {
    title,
    claim: 'The order of two propositions in a conjunction can be reversed.',
    interpretation: input.image
      ? 'The image appears to assert a conjunction.'
      : 'The selected claim is interpreted as conjunction symmetry.',
    summary: 'Extract both propositions, then rebuild their conjunction in reverse.',
    assumptions: ['P and Q are propositions.', 'A proof of P ∧ Q is available.'],
    gaps: input.image ? ['The image does not show the final justification.'] : [],
    imports: [],
    statement: '∀ (P Q : Prop), P ∧ Q → Q ∧ P',
    steps: [
      {
        id: 'introduce',
        title: 'Name the assumptions',
        explanation: 'Introduce the propositions and the supplied conjunction.',
        tactic: 'intro P Q h',
        evidenceIds: ['paper-0'],
        prerequisiteIds: ['conjunction'],
      },
      {
        id: 'reverse',
        title: 'Rebuild in reverse order',
        explanation: 'Use the right and left projections to prove the reversed pair.',
        tactic: input.image ? null : 'exact ⟨h.right, h.left⟩',
        evidenceIds: ['paper-0'],
        prerequisiteIds: ['conjunction'],
      },
    ],
    prerequisites: [
      {
        id: 'conjunction',
        title: title === 'Conjunction' ? 'Implication' : 'Conjunction',
        summary: 'A conjunction contains a proof of each component.',
        kind: 'definition',
      },
    ],
  };
}

const provider: AiProvider = {
  name: 'Test provider',
  model: 'test-astra',
  configured: true,
  generate: async (input) => {
    inputs.push(input);
    return {
      blocks: [
        {
          heading: 'Proof overview',
          text: 'The argument decomposes a conjunction and rebuilds it.',
          evidenceIds: ['paper-0'],
        },
      ],
      proof: proofFor(input),
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
    message: 'Test checker ready.',
  }),
  check: async (proof, signal) => {
    if (waitForCancel && !signal.aborted)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    if (signal.aborted)
      return {
        status: 'cancelled',
        message: 'Check cancelled.',
        diagnostics: [],
        steps: [],
        axioms: [],
      };
    const incomplete = proof.steps.some((step) => step.tactic === null);
    return {
      status: incomplete ? 'incomplete' : 'checked',
      message: incomplete
        ? 'An admitted step remains.'
        : 'The formal statement passed.',
      diagnostics: incomplete
        ? [
            {
              severity: 'warning',
              message: 'declaration uses sorry',
              line: 9,
              column: 2,
            },
          ]
        : [],
      steps: [
        {
          stepId: 'introduce',
          before: ['⊢ ∀ (P Q : Prop), P ∧ Q → Q ∧ P'],
          after: ['P Q : Prop\nh : P ∧ Q\n⊢ Q ∧ P'],
        },
        { stepId: 'reverse', before: ['P Q : Prop\nh : P ∧ Q\n⊢ Q ∧ P'], after: [] },
      ],
      axioms: incomplete ? ['sorryAx'] : [],
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
  await app.listen({ host: '127.0.0.1', port: 8795 });
});
test.afterAll(async () => {
  await app.close();
});
test.beforeEach(() => {
  inputs.length = 0;
  waitForCancel = false;
});

async function openPaper(page: Page, context: BrowserContext): Promise<void> {
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
}

async function selectWord(page: Page): Promise<void> {
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
  await expect(page.getByTestId('selected-highlight')).toHaveCount(1);
}

test('walk through a proof, expand prerequisites recursively and return', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  let waitingForAutomaticCheck = 2;
  await page.route(origin + '/api/solo/runs/*/proof-check', async (route) => {
    if (route.request().method() === 'GET' && waitingForAutomaticCheck-- > 0)
      await route.fulfill({ json: null });
    else await route.continue();
  });
  await selectWord(page);
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction symmetry' }),
  ).toBeVisible();
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toBeVisible();
  await expect(
    workspace.getByRole('button', { name: 'Check with Lean', exact: true }),
  ).toHaveCount(0);
  expect(inputs[0]?.kind).toBe('proof');
  expect(inputs[0]?.selection?.quote).toBe('precise');
  await workspace.getByText('Lean tactic and goals', { exact: true }).click();
  await expect(
    workspace.getByText('P Q : Prop\nh : P ∧ Q\n⊢ Q ∧ P', { exact: true }),
  ).toBeVisible();
  await workspace.getByRole('button', { name: 'Next proof step' }).click();
  await expect(
    workspace.getByRole('heading', { name: '2. Rebuild in reverse order' }),
  ).toBeVisible();
  await expect(
    workspace.getByText('No goals at this position.', { exact: true }),
  ).toBeVisible();
  await workspace.getByText('Step sources (1)').click();
  await expect(
    workspace.getByRole('button', { name: 'Page 1', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/proof-walkthrough-light.png',
    animations: 'disabled',
  });

  await workspace
    .getByRole('button', { name: 'Explain Conjunction', exact: true })
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction', exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(inputs[1]?.selection).toBeNull();
  expect(inputs[1]?.image).toBeNull();
  expect(inputs[1]?.proofContext?.prerequisite?.id).toBe('conjunction');
  expect(inputs[1]?.proofContext?.sourceAnchor?.quote).toBe('precise');
  await workspace
    .getByRole('button', { name: 'Explain Implication', exact: true })
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Implication', exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(3);
  await workspace.getByRole('button', { name: 'Back to parent proof' }).click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction', exact: true }),
  ).toBeVisible();
  await workspace.getByRole('button', { name: 'Back to parent proof' }).click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction symmetry' }),
  ).toBeVisible();
  await workspace
    .getByRole('button', { name: 'Explain Conjunction', exact: true })
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction', exact: true }),
  ).toBeVisible();
  expect(inputs).toHaveLength(3);
  const question = workspace.getByLabel('Explain a prerequisite or proof step');
  await question.fill('Why can we project a pair?');
  await question.press('Enter');
  await expect(
    workspace.getByRole('heading', { name: 'Background explanation' }),
  ).toBeVisible();
  expect(inputs[3]?.proofContext?.prerequisite).toBeNull();
  expect(inputs[3]?.question).toBe('Why can we project a pair?');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Ask about this paper' })
    .fill('Keep my draft');
  await page
    .getByRole('button', { name: 'Open proof walkthrough', exact: true })
    .first()
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction symmetry' }),
  ).toBeVisible();
  expect(inputs).toHaveLength(4);
  await page.getByRole('button', { name: 'Move selection box' }).press('ArrowRight');
  await expect(page.locator('.selection-quote')).toBeVisible();
  await expect(page.locator('.selection-quote')).toHaveText('precise');
  await expect(workspace).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Ask about this paper' })).toHaveValue(
    'Keep my draft',
  );
  expect(inputs).toHaveLength(4);
});

test('a selected image retains its interpretation and an incomplete Lean status', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  await page.getByRole('button', { name: 'Highlight tool' }).click();
  await page.getByRole('button', { name: 'Area', exact: true }).click();
  const surface = await page.getByTestId('region-layer').boundingBox();
  if (!surface) throw new Error('Missing region surface');
  await page.mouse.move(surface.x + 100, surface.y + 335);
  await page.mouse.down();
  await page.mouse.move(surface.x + 370, surface.y + 400);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await expect(
    workspace.getByRole('heading', { name: 'A diagram argument' }),
  ).toBeVisible();
  expect(inputs[0]?.selection?.kind).toBe('region');
  expect(inputs[0]?.image).toMatch(/^data:image\/png;base64,/);
  await expect(workspace.getByText('Incomplete proof', { exact: true })).toBeVisible();
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole('region', { name: 'Formalization gaps' }),
  ).toContainText('The image does not show the final justification.');
  await workspace.getByText('Claim, interpretation and assumptions').click();
  await expect(
    workspace.getByText('The image appears to assert a conjunction.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.screenshot({
    path: 'test-results/proof-walkthrough-dark.png',
    animations: 'disabled',
  });
});

test('proof delivery retries once and an active Lean check can be cancelled', async ({
  page,
  context,
}) => {
  waitForCancel = true;
  await openPaper(page, context);
  const ids: string[] = [];
  let dropped = false;
  await page.route(origin + '/api/solo/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    const response = await route.fetch();
    if (dropped) await route.fulfill({ response });
    else {
      dropped = true;
      await route.fulfill({ status: 503, json: { error: 'Delivery interrupted.' } });
    }
  });
  await selectWord(page);
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await workspace.getByRole('button', { name: 'Retry delivery', exact: true }).click();
  await expect(
    workspace.getByText('Checking with Lean…', { exact: true }),
  ).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(inputs).toHaveLength(1);
  await workspace.getByRole('button', { name: 'Cancel Lean check' }).click();
  await expect(
    workspace.getByText('Lean check cancelled', { exact: true }),
  ).toBeVisible();
  await expect(
    workspace.getByRole('button', { name: 'Check with Lean', exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByText('Create a new walkthrough to revise this proof.'),
  ).toBeVisible();
  await workspace.getByText('Lean tactic and goals', { exact: true }).click();
  await expect(
    workspace.getByText('This check did not record a tactic state for this step.'),
  ).toBeVisible();
});

test('shared walkthroughs and parent navigation survive reloading', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('proof-reader');
  await page.getByLabel('Password', { exact: true }).fill('A-private-test-password-42');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();
  await page.getByRole('button', { name: 'Upload paper and create room' }).click();
  await expect(page.locator('.workspace-dialog')).toHaveCount(0);
  await expect(page.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
  await selectWord(page);
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction symmetry' }),
  ).toBeVisible();
  await workspace
    .getByRole('button', { name: 'Explain Conjunction', exact: true })
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction', exact: true }),
  ).toBeVisible();
  expect(inputs[1]?.proofContext?.parentRunId).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.locator('.rooms-list .library-paper').first().click();
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  await page
    .getByRole('button', { name: 'Open proof walkthrough', exact: true })
    .last()
    .click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction', exact: true }),
  ).toBeVisible();
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toBeVisible();
  await workspace.getByRole('button', { name: 'Back to parent proof' }).click();
  await expect(
    workspace.getByRole('heading', { name: 'Conjunction symmetry' }),
  ).toBeVisible();
  expect(inputs).toHaveLength(2);
});

test('a check for a different source cannot certify the displayed proof', async ({
  page,
  context,
}) => {
  await openPaper(page, context);
  await page.route(origin + '/api/solo/runs/*/proof-check', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body: unknown = await response.json();
    await route.fulfill({
      json:
        body && typeof body === 'object'
          ? { ...body, sourceHash: '0'.repeat(64), status: 'checked' }
          : body,
    });
  });
  await selectWord(page);
  await page.getByRole('button', { name: 'Break down proof', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Proof workspace', exact: true });
  await expect(
    workspace.getByText('This check belongs to another proof revision.'),
  ).toBeVisible();
  await expect(
    workspace.getByText('Formal statement checked', { exact: true }),
  ).toHaveCount(0);
  await workspace.getByText('Lean tactic and goals', { exact: true }).click();
  await expect(workspace.getByText('Before · observed by Lean')).toHaveCount(0);
});
