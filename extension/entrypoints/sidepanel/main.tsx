import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantPanel } from '../../../src/assistant-panel';
import { snapshotSchema, validSnapshot } from '../../../src/bridge';
import type { ReaderSnapshot } from '../../../src/bridge';
import type { Paper } from '../../../src/document';
import { usePdf } from '../../../src/pdf';
import { getPaper, saveHighlight } from '../../../src/storage';
import '../../../src/styles.css';

interface ActiveReader {
  tabId: number;
  snapshot: ReaderSnapshot;
}

function SidePanel(): React.JSX.Element {
  const [active, setActive] = useState<ActiveReader | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [notice, setNotice] = useState('');
  const pdf = usePdf(paper);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      void (async () => {
        const window = await chrome.windows.getCurrent();
        const raw = (await chrome.runtime.sendMessage({
          type: 'read-active',
          windowId: window.id,
        })) as ActiveReader | null;
        const snapshot = snapshotSchema.safeParse(raw?.snapshot);
        const next =
          raw && snapshot.success && validSnapshot(snapshot.data)
            ? {
                tabId: raw.tabId,
                snapshot: snapshot.data,
              }
            : null;
        const stored = next ? await getPaper(next.snapshot.documentId) : null;
        if (cancelled || request !== generation) return;
        setActive(next);
        setPaper((previous) =>
          previous?.id === stored?.id ? previous : (stored ?? null),
        );
        setNotice('');
      })().catch((reason: unknown) => {
        if (!cancelled && request === generation) {
          setActive(null);
          setPaper(null);
          setNotice(
            reason instanceof Error ? reason.message : 'Could not load context.',
          );
        }
      });
    };
    const tabChanged = (): void => {
      setActive(null);
      setPaper(null);
      setNotice('');
      refresh();
    };
    refresh();
    chrome.tabs.onActivated.addListener(tabChanged);
    chrome.storage.onChanged.addListener(refresh);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(tabChanged);
      chrome.storage.onChanged.removeListener(refresh);
    };
  }, []);

  const report = (reason: unknown): void => {
    setNotice(reason instanceof Error ? reason.message : 'Reader action failed.');
  };
  return (
    <div className="native-panel">
      <AssistantPanel
        showThemeToggle
        key={active?.snapshot.sessionId ?? 'empty'}
        context={
          active && paper
            ? {
                documentId: paper.id,
                title: paper.title,
                selection: active.snapshot.selection,
                pages: pdf.pages,
              }
            : null
        }
        indexing={pdf.indexing}
        notice={notice || pdf.error || ''}
        onNavigate={(pageIndex) => {
          if (!active) return;
          void chrome.runtime
            .sendMessage({
              type: 'navigate',
              tabId: active.tabId,
              pageIndex,
              sessionId: active.snapshot.sessionId,
              documentId: active.snapshot.documentId,
            })
            .then((result: { error?: string }) => {
              if (result.error) throw new Error(result.error);
            })
            .catch(report);
        }}
        onSave={() => {
          const anchor = active?.snapshot.selection;
          if (!anchor) return;
          void saveHighlight({
            id: crypto.randomUUID(),
            anchor,
            note: '',
            createdAt: new Date().toISOString(),
          })
            .then(() => {
              const channel = new BroadcastChannel('paper-reader-highlights');
              channel.postMessage('saved');
              channel.close();
              setNotice('Highlight saved on this device.');
            })
            .catch(report);
        }}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing panel root.');
createRoot(root).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
