import { test, expect } from './fixtures';
import { createApp } from '../../server/app';
import type { FastifyInstance } from 'fastify';
import type { AiProvider, ProviderInput } from '../../src/workspace-contract';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

const origin = 'http://127.0.0.1:8793';
let app: FastifyInstance;
const inputs: ProviderInput[] = [];
const provider: AiProvider = {
  name: 'OpenAI',
  model: 'test-astra',
  configured: true,
  generate: async (input) => {
    inputs.push(input);
    return {
      blocks: [
        {
          heading: 'An explanation',
          text: 'A supported explanation of the paper.',
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
  await app.listen({ host: '127.0.0.1', port: 8793 });
});
test.afterAll(async () => {
  await app.close();
});

test('solo Ask submits with Enter, keeps context and needs no account', async ({
  page,
  context,
}) => {
  await context.addInitScript((baseUrl) => {
    localStorage.setItem(
      'brain-vat-service',
      JSON.stringify({ baseUrl, session: null }),
    );
  }, origin);
  await page.goto('/');
  await page.getByTestId('pdf-upload').setInputFiles({
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: makePdfFixture(),
  });
  await page.getByRole('button', { name: 'Toggle reading companion' }).click();
  const question = page.getByRole('textbox', { name: 'Ask about this paper' });
  await expect(question).toBeVisible();
  await question.fill('Explain this');
  await question.press('Shift+Enter');
  await question.pressSequentially('with evidence');
  await expect(question).toHaveValue('Explain this\nwith evidence');
  expect(inputs).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Send AI question' })).toBeEnabled();
  await question.press('Enter');
  await expect(question).toHaveValue('');
  await expect(page.getByText('A supported explanation of the paper.')).toBeVisible();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.question).toBe('Explain this\nwith evidence');
  await question.fill('How does that follow?');
  await question.press('Enter');
  await expect(page.getByText('A supported explanation of the paper.')).toHaveCount(2);
  expect(inputs[1]?.history.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  await page.getByText('Sources (1)').first().click();
  await expect(page.locator('.research-source .citation').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/solo-astra-conversation.png' });
  await page.getByRole('button', { name: 'Find passages', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search this paper' });
  await search.fill('evidence');
  await search.press('Enter');
  await expect(page.getByText('MATCHING PASSAGES', { exact: true })).toBeVisible();
  expect(inputs).toHaveLength(2);
});
