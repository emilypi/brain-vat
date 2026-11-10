import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, chromium } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import type { Page } from '@playwright/test';
import { createApp } from '../../server/app';
import type {
  AiProvider,
  RoomState,
  RoomSummary,
  Session,
} from '../../src/workspace-contract';
import { makePdfFixture } from '../fixtures/pdf-fixtures';

const origin = 'http://127.0.0.1:8792';

// This fixture must never contact a hosted model or require an API key.
const provider: AiProvider = {
  name: 'Extension test provider',
  model: 'fixture',
  configured: true,
  generate: async () => {
    throw new Error('This context-isolation test must not dispatch model requests.');
  },
};

async function nativePanelText(reader: Page): Promise<string> {
  return reader.evaluate(() =>
    chrome.extension
      .getViews()
      .filter((view) => view.location.pathname === '/sidepanel.html')
      .map((view) => view.document.body.innerText)
      .join('\n'),
  );
}

test('the native panel isolates two reading rooms containing the same PDF', async () => {
  test.setTimeout(90_000);
  const extensionPath = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
    ],
  });
  const directory = await mkdtemp(join(tmpdir(), 'brain-vat-extension-'));
  let app: FastifyInstance | null = null;
  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    app = await createApp({
      dbPath: join(directory, 'test.sqlite'),
      provider,
      allowedOrigins: [extensionOrigin],
      registrationOpen: true,
    });
    await app.listen({ host: '127.0.0.1', port: 8792 });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'extension_reader', password: 'Private-test-password-42' },
    });
    expect(registered.statusCode).toBe(201);
    const session = registered.json<Session>();
    const headers = { authorization: 'Bearer ' + session.token };
    const pdf = makePdfFixture().toString('base64');
    const rooms: RoomSummary[] = [];
    for (const title of ['First reading room', 'Second reading room']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { title, filename: 'same-paper.pdf', sourceUrl: null, pdf },
      });
      expect(response.statusCode).toBe(201);
      rooms.push(response.json<RoomSummary>());
    }
    const first = rooms[0];
    const second = rooms[1];
    if (!first || !second) throw new Error('Test room creation failed.');
    expect(first.documentId).toBe(second.documentId);
    for (const [room, text] of [
      [first, 'A thought exclusively in the first room.'],
      [second, 'A thought exclusively in the second room.'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/messages`,
        headers,
        payload: { id: crypto.randomUUID(), text },
      });
      expect(response.statusCode).toBeLessThan(300);
    }
    await context.addInitScript(
      (settings) => {
        localStorage.setItem('brain-vat-service', JSON.stringify(settings));
      },
      { baseUrl: origin, session },
    );
    const reader = await context.newPage();
    await reader.goto(`${extensionOrigin}/reader.html#room=${first.id}`);
    await expect(reader.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
    await reader.getByRole('button', { name: 'Chrome panel' }).click();
    await expect
      .poll(async () =>
        worker.evaluate(
          async () =>
            (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => nativePanelText(reader))
      .toContain('A thought exclusively in the first room.');
    await expect
      .poll(() => nativePanelText(reader))
      .not.toContain('A thought exclusively in the second room.');

    const other = await context.newPage();
    await other.goto(`${extensionOrigin}/reader.html#room=${second.id}`);
    await expect(other.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
    await other.getByRole('button', { name: 'Chrome panel' }).click();
    await expect
      .poll(() => nativePanelText(other))
      .toContain('A thought exclusively in the second room.');
    await expect
      .poll(() => nativePanelText(other))
      .not.toContain('A thought exclusively in the first room.');
    await other.getByRole('button', { name: 'Region', exact: true }).click();
    const bounds = await other.getByTestId('region-layer').boundingBox();
    if (!bounds) throw new Error('Missing extension PDF region layer.');
    await other.mouse.move(bounds.x + 90, bounds.y + 80);
    await other.mouse.down();
    await other.mouse.move(bounds.x + 260, bounds.y + 130, { steps: 8 });
    await other.mouse.up();
    await expect.poll(() => nativePanelText(other)).toContain('Save highlight');
    // Chromium exposes side panels as extension views, not ordinary Page targets.
    await other.evaluate(() => {
      const panel = chrome.extension
        .getViews()
        .find(
          (view) =>
            view.location.pathname === '/sidepanel.html' &&
            view.document.body.innerText.includes(
              'A thought exclusively in the second room.',
            ),
        );
      const button = Array.from(panel?.document.querySelectorAll('button') ?? []).find(
        (element) => element.textContent?.includes('Save highlight'),
      );
      if (!button) throw new Error('Native side-panel save control is unavailable.');
      button.click();
    });
    await expect
      .poll(async () => {
        const response = await app?.inject({
          method: 'GET',
          url: `/api/rooms/${second.id}`,
          headers,
        });
        return response?.json<RoomState>().highlights.length;
      })
      .toBe(1);
    const firstState = await app.inject({
      method: 'GET',
      url: `/api/rooms/${first.id}`,
      headers,
    });
    expect(firstState.json<RoomState>().highlights).toHaveLength(0);
    await reader.bringToFront();
    await expect
      .poll(() => nativePanelText(reader))
      .toContain('A thought exclusively in the first room.');
    await expect
      .poll(() => nativePanelText(reader))
      .not.toContain('A thought exclusively in the second room.');
  } finally {
    await context.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
