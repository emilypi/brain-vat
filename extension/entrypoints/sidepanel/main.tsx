import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantPanel } from '../../../src/assistant-panel';
import { snapshotSchema, validSnapshot } from '../../../src/bridge';
import type { ReaderSnapshot } from '../../../src/bridge';
import type { Paper } from '../../../src/document';
import { identifyPdf } from '../../../src/document';
import { useRoom, useService } from '../../../src/workspace-client';
import type { WorkspaceClient } from '../../../src/workspace-client';
import type { RoomState } from '../../../src/workspace-contract';
import { usePdf } from '../../../src/pdf';
import { getPaper, saveHighlight } from '../../../src/storage';
import '../../../src/styles.css';

interface ActiveReader {
  tabId: number;
  snapshot: ReaderSnapshot;
  client: WorkspaceClient;
}

function SidePanel(): React.JSX.Element {
  const [active, setActive] = useState<ActiveReader | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [notice, setNotice] = useState('');
  const service = useService();
  const room = useRoom(service.client, active?.snapshot.roomId ?? null);
  const cached = useRef<{ key: string; paper: Paper } | null>(null);
  const contextAllowed = active?.client === service.client && !room.forbidden;
  const pdf = usePdf(contextAllowed ? paper : null);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    cached.current = null;
    setActive(null);
    setPaper(null);
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
                client: service.client,
              }
            : null;
        let stored: Paper | null | undefined = null;
        if (next?.snapshot.roomId) {
          const key = next.snapshot.sessionId + next.snapshot.roomId;
          if (cached.current?.key === key) stored = cached.current.paper;
          else {
            const state = await service.client.request<RoomState>(
              '/rooms/' + next.snapshot.roomId,
            );
            const response = await service.client.fetch(
              '/rooms/' + next.snapshot.roomId + '/pdf',
            );
            const bytes = await response.arrayBuffer();
            if ((await identifyPdf(bytes)) !== next.snapshot.documentId) {
              throw new Error('Room PDF identity changed. Reopen the reader.');
            }
            stored = {
              id: state.room.documentId,
              title: state.room.title,
              filename: state.room.filename,
              sourceUrl: state.room.sourceUrl,
              addedAt: state.room.createdAt,
              pageCount: state.room.pageCount,
              bytes,
            };
            if (!cancelled && request === generation)
              cached.current = { key, paper: stored };
          }
        } else if (next) stored = await getPaper(next.snapshot.documentId);
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
  }, [service.client]);

  const report = (reason: unknown): void => {
    setNotice(reason instanceof Error ? reason.message : 'Reader action failed.');
  };
  return (
    <div className="native-panel">
      <AssistantPanel
        showThemeToggle
        room={room.connection}
        pdfDocument={pdf.document}
        key={active?.snapshot.sessionId ?? 'empty'}
        context={
          active &&
          contextAllowed &&
          paper &&
          !room.forbidden &&
          (!active.snapshot.roomId || service.session)
            ? {
                documentId: paper.id,
                title: paper.title,
                selection: active.snapshot.selection,
                pages: pdf.pages,
              }
            : null
        }
        indexing={pdf.indexing}
        notice={notice || room.error || pdf.error || ''}
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
          const highlight = {
            id: crypto.randomUUID(),
            anchor,
            note: '',
            createdAt: new Date().toISOString(),
          };
          if (active.snapshot.roomId && !room.connection) {
            setNotice('Wait for the shared room to reconnect.');
            return;
          }
          const save = room.connection
            ? service.client
                .request('/rooms/' + active.snapshot.roomId + '/highlights', {
                  method: 'POST',
                  body: JSON.stringify({
                    id: highlight.id,
                    anchor: highlight.anchor,
                    note: highlight.note,
                  }),
                })
                .then(() => room.connection?.refresh())
            : saveHighlight(highlight);
          void save
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
