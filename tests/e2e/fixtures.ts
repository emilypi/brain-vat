import { test as base, expect, chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

/** Browser regressions must never call the user's configured production LLM. */
export async function blockProductionAI(context: BrowserContext): Promise<void> {
  await context.route(/http:\/\/127\.0\.0\.1:(5173|8787)\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/health') {
      await route.fulfill({
        json: {
          provider: 'Test',
          model: 'fixture',
          configured: false,
          soloAvailable: false,
          registrationOpen: false,
        },
      });
    } else await route.abort('blockedbyclient');
  });
}

export const test = base.extend<{ isolatedAI: void }>({
  isolatedAI: [
    async ({ context }, use) => {
      await blockProductionAI(context);
      await use();
    },
    { auto: true },
  ],
});
export { expect, chromium };
