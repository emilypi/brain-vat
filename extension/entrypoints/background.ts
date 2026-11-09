import { defineBackground } from 'wxt/utils/define-background';
import { bridgeMessageSchema, matchesReader, validSnapshot } from '../../src/bridge';
import type { ReaderSnapshot } from '../../src/bridge';
import { parsePaperUrl } from '../../src/document';

export interface TabReader {
  tabId: number;
  browserDocumentId: string;
  sessionId: string;
  snapshot: ReaderSnapshot | null;
}

export default defineBackground(() => {
  const readerUrl = chrome.runtime.getURL('reader.html');
  const panelUrl = chrome.runtime.getURL('sidepanel.html');
  const key = (tabId: number): string => 'reader:' + tabId;
  const pending = new Map<number, Promise<unknown>>();
  const inOrder = <T>(tabId: number, operation: () => Promise<T>): Promise<T> => {
    const previous = pending.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    pending.set(tabId, next);
    const clean = (): void => {
      if (pending.get(tabId) === next) pending.delete(tabId);
    };
    void next.then(clean, clean);
    return next;
  };
  const read = async (tabId: number): Promise<TabReader | undefined> => {
    const saved = await chrome.storage.session.get(key(tabId));
    return saved[key(tabId)] as TabReader | undefined;
  };
  const isLive = async (reader: TabReader): Promise<boolean> => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      tabIds: [reader.tabId],
      documentIds: [reader.browserDocumentId],
    });
    return contexts.length > 0;
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
      if (message.type === 'publish' || message.type === 'clear') {
        if (
          !fromReader ||
          sender.tab?.id === undefined ||
          !sender.documentId ||
          (message.type === 'publish' && !validSnapshot(message.snapshot))
        )
          throw new Error('Invalid reader context.');
        const tabId = sender.tab.id;
        const browserDocumentId = sender.documentId;
        return inOrder(tabId, async () => {
          if (message.type === 'clear') {
            const value: TabReader = {
              tabId,
              browserDocumentId,
              sessionId: message.sessionId,
              snapshot: null,
            };
            await chrome.storage.session.set({ [key(tabId)]: value });
            return { ok: true };
          }
          const current = await read(tabId);
          if (current?.sessionId !== message.snapshot.sessionId) {
            return { ok: true, ignored: true };
          }
          const value: TabReader = {
            tabId,
            browserDocumentId,
            sessionId: message.snapshot.sessionId,
            snapshot: message.snapshot,
          };
          await chrome.storage.session.set({ [key(tabId)]: value });
          await chrome.sidePanel.setOptions({
            tabId,
            path: 'sidepanel.html',
            enabled: true,
          });
          return { ok: true };
        });
      }
      if (!fromPanel) throw new Error('Only the reading panel can request context.');
      if (message.type === 'read-active') {
        const [tab] = await chrome.tabs.query({
          active: true,
          windowId: message.windowId,
        });
        if (tab?.id === undefined) return null;
        const tabId = tab.id;
        const current = await inOrder(tabId, () => read(tabId));
        return current?.snapshot && (await isLive(current)) ? current : null;
      }
      const stored = await read(message.tabId);
      const target = await chrome.tabs.get(message.tabId);
      if (
        !stored?.snapshot ||
        !(await isLive(stored)) ||
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
    void inOrder(tabId, () => chrome.storage.session.remove(key(tabId)));
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status) {
      void inOrder(tabId, async () => {
        const current = await read(tabId);
        if (current && (await isLive(current))) return;
        await chrome.storage.session.remove(key(tabId));
        await chrome.sidePanel.setOptions({ tabId, enabled: false });
      });
    }
  });
});
