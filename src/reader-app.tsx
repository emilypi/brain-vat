import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Highlighter,
  Link,
  PanelRight,
  Plus,
  RotateCw,
  Scan,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AssistantPanel } from './assistant-panel';
import { WEB_ENVIRONMENT } from './bridge';
import type { ReaderEnvironment } from './bridge';
import {
  anchorSchema,
  EXAMPLE_HASH,
  EXAMPLE_URL,
  MAX_PDF_BYTES,
  parsePaperUrl,
} from './document';
import type { Anchor, Highlight, Paper } from './document';
import { createPaper, fetchPdf } from './import-paper';
import { usePdf } from './pdf';
import { PdfPage } from './pdf-page';
import {
  getPaper,
  listHighlights,
  listPapers,
  removeHighlight,
  saveHighlight,
  savePaper,
} from './storage';

interface ReaderAppProps {
  environment?: ReaderEnvironment;
}

export function ReaderApp({
  environment = WEB_ENVIRONMENT,
}: ReaderAppProps): React.JSX.Element {
  const [library, setLibrary] = useState<Paper[]>([]);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [pageIndex, setPageIndex] = useState(0);
  const [scale, setScale] = useState(1.05);
  const [rotation, setRotation] = useState(0);
  const [regionMode, setRegionMode] = useState(false);
  const [selection, setSelection] = useState<Anchor | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [url, setUrl] = useState(() => {
    return new URLSearchParams(location.search).get('source') ?? '';
  });
  const [showPanel, setShowPanel] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const pdf = usePdf(paper);
  const openGeneration = useRef(0);

  const report = useCallback((reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : 'Something went wrong.');
  }, []);

  const openPaper = useCallback(
    async (next: Paper): Promise<void> => {
      const generation = ++openGeneration.current;
      setError('');
      const saved = await listHighlights(next.id);
      if (generation !== openGeneration.current) return;
      const nextSession = crypto.randomUUID();
      await environment.clear(nextSession);
      if (generation !== openGeneration.current) return;
      setPaper(next);
      setHighlights(saved);
      setSelection(null);
      setNotice('');
      setPageIndex(0);
      setRotation(0);
      setRegionMode(false);
      setSessionId(nextSession);
      const target = new URL(location.href);
      target.hash = 'doc=' + next.id;
      history.replaceState(null, '', target);
    },
    [environment],
  );

  useEffect(() => {
    let cancelled = false;
    void listPapers()
      .then(async (papers) => {
        if (cancelled) return;
        setLibrary(papers);
        const id = new URLSearchParams(location.hash.slice(1)).get('doc');
        const previous = papers.find((item) => item.id === id);
        if (previous) await openPaper(previous);
        if (new URLSearchParams(location.search).has('source')) setShowImport(true);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [openPaper, report]);

  useEffect(() => {
    if (!paper || !pdf.document) return;
    const next = { ...paper, pageCount: pdf.document.numPages };
    if (paper.pageCount === next.pageCount) return;
    void savePaper(next)
      .then(() => {
        setLibrary((current) =>
          current.map((item) => (item.id === next.id ? next : item)),
        );
        setPaper((current) => (current?.id === next.id ? next : current));
      })
      .catch(report);
  }, [paper, pdf.document, report]);

  useEffect(() => {
    if (!paper || !pdf.document) return;
    void environment
      .publish({
        sessionId,
        documentId: paper.id,
        title: paper.title,
        pageCount: pdf.document.numPages,
        pageIndex,
        selection,
      })
      .catch(report);
  }, [environment, paper, pdf.document, sessionId, pageIndex, selection, report]);

  useEffect(
    () =>
      environment.onNavigate((documentId, targetSession, index) => {
        if (
          paper?.id === documentId &&
          sessionId === targetSession &&
          pdf.document &&
          index < pdf.document.numPages
        )
          setPageIndex(index);
      }),
    [environment, paper?.id, sessionId, pdf.document],
  );

  useEffect(() => {
    if (!paper) return;
    let cancelled = false;
    const refresh = (): void => {
      void listHighlights(paper.id)
        .then((saved) => {
          if (!cancelled) setHighlights(saved);
        })
        .catch(report);
    };
    window.addEventListener('focus', refresh);
    const channel = new BroadcastChannel('paper-reader-highlights');
    channel.onmessage = refresh;
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
      channel.close();
    };
  }, [paper, report]);

  const importBytes = async (
    bytes: ArrayBuffer,
    filename: string,
    source: string | null,
  ): Promise<void> => {
    const next = await createPaper(bytes, filename, source);
    if (next.id === EXAMPLE_HASH) next.title = 'Vectorizing Recurrences over Semirings';
    const existing = await getPaper(next.id);
    await savePaper(existing ?? next);
    setLibrary(await listPapers());
    await openPaper(existing ?? next);
    setShowImport(false);
  };

  const runImport = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };

  const importUrl = (): void => {
    void runImport(async () => {
      const source = parsePaperUrl(url);
      await environment.requestOrigin(source);
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchPdf(source);
      } catch (reason) {
        if (reason instanceof TypeError) {
          throw new Error(
            'This site could not be fetched. Download the PDF and use Open PDF instead.',
            { cause: reason },
          );
        }
        throw reason;
      }
      const filename = new URL(source).pathname.split('/').pop() || 'Untitled PDF';
      await importBytes(bytes, filename, source);
    });
  };

  const saveSelection = (): void => {
    if (!selection || selection.documentId !== paper?.id) return;
    const highlight: Highlight = {
      id: crypto.randomUUID(),
      anchor: anchorSchema.parse(selection),
      note: '',
      createdAt: new Date().toISOString(),
    };
    void saveHighlight(highlight)
      .then(() => {
        setHighlights((current) => [...current, highlight]);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        setNotice('Highlight saved on this device.');
      })
      .catch(report);
  };

  const pageCount = pdf.document?.numPages ?? 0;
  return (
    <div className={'reader-app' + (showPanel ? '' : ' panel-hidden')}>
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-testid="pdf-upload"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void runImport(async () => {
            if (file.size > MAX_PDF_BYTES) throw new Error('Choose a PDF under 25 MB.');
            await importBytes(await file.arrayBuffer(), file.name, null);
          });
        }}
      />
      <nav className="library-sidebar" aria-label="Library">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setShowImport(true);
          }}
        >
          <span className="brand-mark">
            <BookOpen size={19} />
          </span>
          margin<span> / </span>
        </a>
        <div className="workspace-label">
          <span className="avatar">E</span>My reading space
        </div>
        <button
          className="new-paper"
          disabled={busy}
          onClick={() => setShowImport(true)}
        >
          <Plus size={16} /> Open a paper
        </button>
        <div className="library-section">
          <div className="section-label">
            YOUR LIBRARY <span>{library.length}</span>
          </div>
          {library.length === 0 && (
            <p className="muted small">A home for your next idea.</p>
          )}
          {library.map((item) => (
            <button
              className={'library-paper' + (item.id === paper?.id ? ' active' : '')}
              key={item.id}
              onClick={() => {
                void openPaper(item).catch(report);
              }}
              disabled={busy}
            >
              <FileText size={16} />
              <span>
                {item.title}
                <small>{item.pageCount || '—'} pages · PDF</small>
              </span>
            </button>
          ))}
        </div>
        {paper && (
          <div className="library-section saved-section">
            <div className="section-label">
              HIGHLIGHTS <span>{highlights.length}</span>
            </div>
            {highlights.length === 0 && (
              <p className="muted small">Keep the passages you want to come back to.</p>
            )}
            {highlights.map((highlight) => (
              <div className="saved-item" key={highlight.id}>
                <button onClick={() => setPageIndex(highlight.anchor.pageIndex)}>
                  <span className="highlight-dot" />
                  <span>
                    {highlight.anchor.quote || 'Equation or figure region'}
                    <small>Page {highlight.anchor.pageIndex + 1}</small>
                  </span>
                </button>
                <button
                  className="delete-highlight"
                  aria-label="Delete highlight"
                  onClick={() => {
                    void removeHighlight(highlight.id)
                      .then(() => {
                        setHighlights((items) =>
                          items.filter((h) => h.id !== highlight.id),
                        );
                      })
                      .catch(report);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="library-footer">
          <span className="status-dot" />
          Saved on this device<small>Your private, local prototype</small>
        </div>
      </nav>
      <main className="reading-area">
        <header className="document-header">
          <div className="breadcrumb">
            Library <ChevronRight size={13} />
            <span>{paper ? 'Reading room' : 'Welcome'}</span>
          </div>
          <div className="header-actions">
            {paper?.sourceUrl && (
              <a
                href={paper.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title="Open original"
              >
                <ExternalLink size={16} />
                <span>Original</span>
              </a>
            )}
            {environment.nativePanel && (
              <button
                className="text-button"
                onClick={() => {
                  void environment
                    .openPanel()
                    .then(() => setShowPanel(false))
                    .catch(report);
                }}
                disabled={!pdf.document}
              >
                <PanelRight size={16} /> Chrome panel
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Toggle reading companion"
              aria-pressed={showPanel}
              onClick={() => setShowPanel(!showPanel)}
            >
              <PanelRight size={17} />
            </button>
          </div>
        </header>
        {(error || pdf.error) && (
          <div className="error-banner" role="alert">
            <span>{error || pdf.error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => {
                setError('');
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {paper ? (
          <>
            <div className="paper-heading">
              <div className="eyebrow">
                {paper.sourceUrl ? 'RESEARCH PAPER' : 'YOUR PDF'}
              </div>
              <h1>{paper.title}</h1>
              <div className="paper-meta">
                <span>PDF</span>
                {pageCount ? `${pageCount} pages` : 'Opening paper…'}
                <span className="meta-separator">·</span>
                <Check size={13} /> Stored locally
              </div>
            </div>
            <div className="reader-toolbar" aria-label="PDF controls">
              <div className="toolbar-group">
                <button
                  className="icon-button"
                  aria-label="Previous page"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex(pageIndex - 1)}
                >
                  <ArrowLeft size={16} />
                </button>
                <label className="page-number">
                  <span className="sr-only">Page number</span>
                  <input
                    type="number"
                    min={1}
                    max={pageCount || 1}
                    value={pageIndex + 1}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value > 0 && value <= pageCount) {
                        setPageIndex(value - 1);
                      }
                    }}
                  />
                  <span>/ {pageCount || '—'}</span>
                </label>
                <button
                  className="icon-button"
                  aria-label="Next page"
                  disabled={pageIndex + 1 >= pageCount}
                  onClick={() => setPageIndex(pageIndex + 1)}
                >
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="toolbar-group zoom-controls">
                <button
                  className="icon-button"
                  aria-label="Zoom out"
                  disabled={scale <= 0.55}
                  onClick={() => setScale(scale - 0.15)}
                >
                  <ZoomOut size={16} />
                </button>
                <span className="zoom-value">{Math.round(scale * 100)}%</span>
                <button
                  className="icon-button"
                  aria-label="Zoom in"
                  disabled={scale >= 2}
                  onClick={() => setScale(scale + 0.15)}
                >
                  <ZoomIn size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Rotate page"
                  onClick={() => setRotation((rotation + 90) % 360)}
                >
                  <RotateCw size={15} />
                </button>
              </div>
              <button
                className={'region-button' + (regionMode ? ' active' : '')}
                aria-pressed={regionMode}
                onClick={() => setRegionMode(!regionMode)}
              >
                <Scan size={15} /> Region
              </button>
            </div>
            <div className="page-stage">
              {pdf.document ? (
                <PdfPage
                  key={paper.id}
                  document={pdf.document}
                  documentId={paper.id}
                  pageIndex={pageIndex}
                  scale={scale}
                  rotation={rotation}
                  regionMode={regionMode}
                  highlights={highlights}
                  selection={selection}
                  onSelect={(anchor) => {
                    setSelection(anchor);
                    setNotice('');
                  }}
                />
              ) : (
                <div className="empty-stage">Opening your paper…</div>
              )}
            </div>
            <footer className="reader-footer">
              <Highlighter size={13} />
              {regionMode
                ? 'Drag a rectangle around an equation or figure.'
                : 'Select a passage to keep it or explore its context.'}
              <span>Original PDF</span>
            </footer>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-symbol">
              <BookOpen size={38} strokeWidth={1.4} />
            </div>
            <div className="eyebrow">MAKE ROOM FOR UNDERSTANDING</div>
            <h1>
              Good papers deserve
              <br />a little margin.
            </h1>
            <p>
              A quiet place to read closely, follow ideas,
              <br />
              and keep what matters.
            </p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                void runImport(async () => {
                  const bytes = await fetchPdf('/samples/2611.02451v1.pdf');
                  await importBytes(bytes, '2611.02451v1.pdf', EXAMPLE_URL);
                });
              }}
            >
              {busy ? 'Opening…' : 'Read the example paper'}
              <ArrowRight size={16} />
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={15} /> Open your own PDF
            </button>
            <div className="welcome-footnote">LOCAL PROTOTYPE · NO ACCOUNT NEEDED</div>
          </div>
        )}
      </main>
      {showPanel && (
        <AssistantPanel
          key={paper?.id ?? 'empty'}
          context={
            paper
              ? {
                  title: paper.title,
                  documentId: paper.id,
                  selection,
                  pages: pdf.pages,
                }
              : null
          }
          indexing={pdf.indexing}
          onNavigate={setPageIndex}
          onSave={saveSelection}
          notice={notice}
        />
      )}
      {showImport && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget && !busy) setShowImport(false);
          }}
        >
          <section
            className="import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <button
              className="icon-button modal-close"
              aria-label="Close import"
              disabled={busy}
              onClick={() => setShowImport(false)}
            >
              <X size={18} />
            </button>
            <div className="eyebrow">ADD TO YOUR READING SPACE</div>
            <h2 id="import-title">Bring a paper.</h2>
            <p className="muted">
              Open an arXiv link, a public PDF, or a file on your device.
            </p>
            <button
              className="upload-button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ArrowDownToLine size={22} />
              <strong>Open PDF</strong>
              <span>Choose a file · up to 25 MB</span>
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                importUrl();
              }}
            >
              <label htmlFor="paper-url">Or paste a paper link</label>
              <div className="url-field">
                <Link size={16} />
                <input
                  id="paper-url"
                  type="url"
                  value={url}
                  required
                  placeholder="https://arxiv.org/abs/…"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
              {error && (
                <p className="import-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? 'Opening…' : 'Open paper'}
                <ArrowRight size={16} />
              </button>
            </form>
            <p className="small muted">PDFs and highlights stay in this browser.</p>
          </section>
        </div>
      )}
    </div>
  );
}
