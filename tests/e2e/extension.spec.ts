import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';

test('native panel opens and rejects stale navigation', async () => {
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
  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const reader = await context.newPage();
    await reader.goto(`chrome-extension://${extensionId}/reader.html`);
    await reader.getByRole('button', { name: 'Read the example paper' }).click();
    await expect(reader.getByTestId('pdf-page')).toHaveAttribute('data-ready', 'true');
    await expect(reader.getByRole('alert')).toHaveCount(0);
    await reader.getByRole('button', { name: 'Chrome panel' }).click();
    await expect
      .poll(async () =>
        worker.evaluate(async () => {
          return (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
            .length;
        }),
      )
      .toBe(1);

    // Opening the packaged panel in a tab also lets us inspect message boundary errors.
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await reader.bringToFront();
    const tabId = await reader.evaluate(
      async () => (await chrome.tabs.getCurrent())?.id,
    );
    expect(tabId).toBeDefined();
    const windowId = await reader.evaluate(
      async () => (await chrome.windows.getCurrent()).id,
    );
    const stored = (await panel.evaluate(async (id) => {
      return chrome.runtime.sendMessage({ type: 'read-active', windowId: id });
    }, windowId)) as { snapshot: { sessionId: string; documentId: string } };
    expect(stored.snapshot.documentId).toMatch(/^[a-f0-9]{64}$/);
    const result = (await panel.evaluate(
      async ({ id, snapshot }) => {
        return chrome.runtime.sendMessage({
          type: 'navigate',
          tabId: id,
          pageIndex: 3,
          documentId: snapshot.documentId,
          sessionId: crypto.randomUUID(),
        });
      },
      { id: tabId, snapshot: stored.snapshot },
    )) as { error: string };
    expect(result.error).toContain('different reading session');
    await expect(reader.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(
      '1',
    );
    await panel.evaluate(
      async ({ id, snapshot }) => {
        return chrome.runtime.sendMessage({
          type: 'navigate',
          tabId: id,
          pageIndex: 3,
          documentId: snapshot.documentId,
          sessionId: snapshot.sessionId,
        });
      },
      { id: tabId, snapshot: stored.snapshot },
    );
    await expect(reader.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(
      '4',
    );
    const otherTab = await context.newPage();
    await otherTab.goto('about:blank');
    await expect
      .poll(async () =>
        panel.evaluate(async (id) => {
          return chrome.runtime.sendMessage({ type: 'read-active', windowId: id });
        }, windowId),
      )
      .toBeNull();
    const inactive = (await panel.evaluate(
      async ({ id, snapshot }) => {
        return chrome.runtime.sendMessage({
          type: 'navigate',
          tabId: id,
          pageIndex: 1,
          documentId: snapshot.documentId,
          sessionId: snapshot.sessionId,
        });
      },
      { id: tabId, snapshot: stored.snapshot },
    )) as { error: string };
    expect(inactive.error).toContain('different reading session');
    await reader.bringToFront();
    await expect
      .poll(async () =>
        panel.evaluate(async (id) => {
          const active = await chrome.runtime.sendMessage({
            type: 'read-active',
            windowId: id,
          });
          return active?.snapshot.sessionId as string | undefined;
        }, windowId),
      )
      .toBe(stored.snapshot.sessionId);
    await reader.getByTestId('pdf-upload').setInputFiles({
      name: 'broken.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nnot a valid PDF structure\n'),
    });
    await expect(reader.getByRole('alert')).toContainText('Invalid PDF');
    await expect
      .poll(async () =>
        panel.evaluate(async (id) => {
          return chrome.runtime.sendMessage({ type: 'read-active', windowId: id });
        }, windowId),
      )
      .toBeNull();
    await reader.goto('about:blank');
    await expect
      .poll(async () =>
        panel.evaluate(async (id) => {
          return chrome.runtime.sendMessage({ type: 'read-active', windowId: id });
        }, windowId),
      )
      .toBeNull();
  } finally {
    await context.close();
  }
});
