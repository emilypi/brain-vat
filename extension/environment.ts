import { z } from 'zod';
import type { ReaderEnvironment } from '../src/bridge';

const navigationSchema = z.object({
  type: z.literal('navigate-target'),
  tabId: z.number().int(),
  documentId: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().uuid(),
  pageIndex: z.number().int().nonnegative(),
});

export async function extensionEnvironment(): Promise<ReaderEnvironment> {
  const tab = await chrome.tabs.getCurrent();
  const tabId = tab?.id;
  if (tabId === undefined) throw new Error('Open the reader in a browser tab.');
  return {
    nativePanel: true,
    clear: async (sessionId) => {
      const result = (await chrome.runtime.sendMessage({
        type: 'clear',
        sessionId,
      })) as {
        error?: string;
      };
      if (result.error) throw new Error(result.error);
    },
    requestOrigin: async (url) => {
      const origins = [new URL(url).origin + '/*'];
      if (!(await chrome.permissions.request({ origins }))) {
        throw new Error(
          'Site access was declined. You can still open a downloaded PDF.',
        );
      }
    },
    publish: async (snapshot) => {
      const result = (await chrome.runtime.sendMessage({
        type: 'publish',
        snapshot,
      })) as {
        error?: string;
      };
      if (result.error) throw new Error(result.error);
    },
    openPanel: () => chrome.sidePanel.open({ tabId }),
    onNavigate: (callback) => {
      const listener = (raw: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.id !== chrome.runtime.id) return;
        const message = navigationSchema.safeParse(raw);
        if (!message.success || message.data.tabId !== tabId) return;
        const { documentId, sessionId, pageIndex } = message.data;
        callback(documentId, sessionId, pageIndex);
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
}
