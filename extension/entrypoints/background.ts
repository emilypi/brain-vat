import { defineBackground } from 'wxt/utils/define-background';
import { bridgeMessageSchema, matchesReader, validSnapshot } from '../../src/bridge';
import type { ReaderSnapshot } from '../../src/bridge';
import { parsePaperUrl } from '../../src/document';

export interface TabReader {
  tabId: number;
  snapshot: ReaderSnapshot;
}

export default defineBackground(() => {
  const readerUrl = chrome.runtime.getURL('reader.html');
  const panelUrl = chrome.runtime.getURL('sidepanel.html');
  const key = (tabId: number): string => 'reader:' + tabId;
  const read = async (tabId: number): Promise<TabReader | undefined> => {
    const saved = await chrome.storage.session.get(key(tabId));
    return saved[key(tabId)] as TabReader | undefined;
  };

  chrome.action.onClicked.addListener((tab) => {
    let source = '';
    if (tab.url) {
      try {
        source = parsePaperUrl(tab.url);
      } catch {
        /* Open an empty reader. */
      }
    }
    const target = new URL(readerUrl);
    if (source) target.searchParams.set('source', source);
    void chrome.tabs.create({ url: target.href });
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    const parsed = bridgeMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const message = parsed.data;
    const senderUrl = sender.url ? new URL(sender.url) : null;
    if (senderUrl) {
      senderUrl.search = '';
      senderUrl.hash = '';
    }
    const fromReader = senderUrl?.href === readerUrl;
    const fromPanel = senderUrl?.href === panelUrl;
    const handle = async (): Promise<unknown> => {
      if (message.type === 'publish') {
        if (
          !fromReader ||
          sender.tab?.id === undefined ||
          !validSnapshot(message.snapshot)
        )
          throw new Error('Invalid reader context.');
        const tabId = sender.tab.id;
        const value: TabReader = { tabId, snapshot: message.snapshot };
        await chrome.storage.session.set({ [key(tabId)]: value });
        await chrome.sidePanel.setOptions({
          tabId,
          path: 'sidepanel.html',
          enabled: true,
        });
        return { ok: true };
      }
      if (!fromPanel) throw new Error('Only the reading panel can request context.');
      if (message.type === 'read-active') {
        const [tab] = await chrome.tabs.query({
          active: true,
          windowId: message.windowId,
        });
        return tab?.id === undefined ? null : ((await read(tab.id)) ?? null);
      }
      const stored = await read(message.tabId);
      const target = await chrome.tabs.get(message.tabId);
      if (
        !stored ||
        !target.active ||
        !matchesReader(stored.snapshot, message.sessionId, message.documentId) ||
        message.pageIndex >= stored.snapshot.pageCount
      ) {
        throw new Error('This source belongs to a different reading session.');
      }
      await chrome.runtime.sendMessage({ ...message, type: 'navigate-target' });
      return { ok: true };
    };
    void handle()
      .then(respond)
      .catch((reason: unknown) => {
        respond({
          error: reason instanceof Error ? reason.message : 'Reader request failed.',
        });
      });
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(key(tabId));
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading') {
      void chrome.storage.session.remove(key(tabId));
      void chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  });
});
