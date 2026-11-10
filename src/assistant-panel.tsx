import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  CornerUpRight,
  Highlighter,
  Quote,
  Search,
  X,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import { findEvidence, pointToViewport } from './document';
import { ThemeToggle } from './theme-toggle';
import { AnswerContent } from './enhanced-reader';
import { runInputSchema } from './workspace-contract';
import type { AssistantContext } from './bridge';
import type { Anchor, Evidence, PageBox, Transform } from './document';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RoomConnection } from './workspace-client';
import type { AiRun, RunInput, ServiceStatus } from './workspace-contract';
import './research.css';

interface AssistantPanelProps {
  context: AssistantContext | null;
  indexing: boolean;
  onNavigate: (pageIndex: number) => void;
  onSave: () => void;
  notice: string;
  showThemeToggle?: boolean;
  room?: RoomConnection | null;
  pdfDocument?: PDFDocumentProxy | null;
}

function LocalAssistantPanel({
  context,
  indexing,
  onNavigate,
  onSave,
  notice,
  showThemeToggle = false,
}: AssistantPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const selection = context?.selection;

  const search = (text: string): void => {
    if (!context || !text.trim()) return;
    setSubmitted(text);
    setEvidence(findEvidence(text, context.pages));
  };

  return (
    <aside className="assistant-panel" aria-label="Reading companion">
      <header className="panel-header">
        <div className="panel-heading-row">
          <div className="eyebrow">
            <span className="status-dot" /> READING COMPANION
          </div>
          {showThemeToggle && <ThemeToggle />}
        </div>
        <h2>A little more context.</h2>
        <p>Follow an idea without losing your place.</p>
      </header>
      <div className="panel-scroll">
        <div className="mode-note">
          <BookOpen size={15} />
          <span>
            Local evidence mode <span className="muted">· No AI connected</span>
          </span>
        </div>
        {context ? (
          <>
            <section className="selection-card">
              <div className="section-label">
                <Quote size={14} /> YOUR SELECTION
              </div>
              {selection ? (
                <>
                  <p className="selection-quote">
                    {selection.quote || 'Selected equation or figure region'}
                  </p>
                  <div className="selection-actions">
                    <button
                      className="text-button"
                      onClick={() => {
                        onNavigate(selection.pageIndex);
                      }}
                    >
                      Page {selection.pageIndex + 1} <CornerUpRight size={13} />
                    </button>
                    <button className="text-button" onClick={onSave}>
                      <Highlighter size={14} /> Save highlight
                    </button>
                    {selection.quote && (
                      <button
                        className="text-button"
                        disabled={indexing}
                        onClick={() => {
                          setQuery(selection.quote);
                          search(selection.quote);
                        }}
                      >
                        <Search size={13} /> Find in paper
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="muted">
                  Select a passage in the paper, or use Region to capture an equation.
                </p>
              )}
            </section>
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            {!submitted && (
              <section className="suggestions">
                <div className="section-label">START WITH A QUESTION</div>
                {['What does convolution mean here?', 'Where is semiring defined?'].map(
                  (prompt) => (
                    <button
                      key={prompt}
                      disabled={indexing}
                      onClick={() => {
                        setQuery(prompt);
                        search(prompt);
                      }}
                    >
                      {prompt}
                      <CornerUpRight size={15} />
                    </button>
                  ),
                )}
                <p className="muted small">
                  Search returns passages from this PDF. Generated explanations and
                  external sources will arrive when a model is connected.
                </p>
              </section>
            )}
            {submitted && (
              <section className="evidence-results" aria-live="polite">
                <div className="query-bubble">{submitted}</div>
                <div className="section-label">
                  <Search size={14} /> MATCHING PASSAGES
                </div>
                {evidence.length ? (
                  evidence.map((item) => (
                    <article className="evidence-card" key={item.pageIndex}>
                      <div className="evidence-origin">This paper</div>
                      <p>{item.excerpt}</p>
                      <button
                        className="citation"
                        onClick={() => onNavigate(item.pageIndex)}
                      >
                        Page {item.pageIndex + 1} <CornerUpRight size={13} />
                      </button>
                    </article>
                  ))
                ) : (
                  <p className="muted">
                    No matching text found. Try a term from the paper. Equations may
                    need a region selection because PDF text can lose notation.
                  </p>
                )}
              </section>
            )}
          </>
        ) : (
          <div className="panel-empty">
            <BookOpen size={28} />
            <h3>Your paper, in focus.</h3>
            <p>Open a PDF to collect passages, save highlights and follow sources.</p>
          </div>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          search(query);
        }}
      >
        <label className="sr-only" htmlFor="question">
          Search this paper
        </label>
        <textarea
          id="question"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask a question or search a term…"
          disabled={!context}
          rows={2}
        />
        <div className="composer-footer">
          <span>{indexing ? 'Indexing paper…' : 'Sources stay one click away'}</span>
          <button
            type="submit"
            className="send-button"
            aria-label="Find supporting passages"
            disabled={!context || indexing || !query.trim()}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </aside>
  );
}

/** Render only the selected region, bounded independently of the PDF page size. */
async function captureRegion(pdf: PDFDocumentProxy, anchor: Anchor): Promise<string> {
  const page = await pdf.getPage(anchor.pageIndex + 1);
  const original = page.getViewport({ scale: 1 });
  const box = page.view as unknown as PageBox;
  const points = anchor.quads
    .flat()
    .map((point) =>
      pointToViewport(point, original.transform as unknown as Transform, box),
    );
  const left = Math.max(0, Math.min(...points.map((point) => point.x)));
  const top = Math.max(0, Math.min(...points.map((point) => point.y)));
  const right = Math.min(original.width, Math.max(...points.map((point) => point.x)));
  const bottom = Math.min(original.height, Math.max(...points.map((point) => point.y)));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) throw new Error('Select a larger equation region.');
  const scale = Math.min(2, 1200 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  try {
    await page.render({
      canvas,
      viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -left * scale, -top * scale],
      background: '#ffffff',
    }).promise;
    const image = canvas.toDataURL('image/png');
    if (image.length > 3_000_000) {
      throw new Error('This region is too detailed. Select a smaller area and retry.');
    }
    return image;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

interface SharedAssistantProps extends AssistantPanelProps {
  room: RoomConnection;
  context: AssistantContext;
}

interface PendingRun {
  roomId: string;
  documentId: string;
  input: RunInput;
}

interface SharedRunCardProps {
  run: AiRun;
  canceling: string | null;
  pageCount: number;
  onCancel: (run: AiRun) => void;
  onNavigate: (pageIndex: number) => void;
}

function SharedRunCard({
  run,
  canceling,
  pageCount,
  onCancel,
  onNavigate,
}: SharedRunCardProps): React.JSX.Element {
  return (
    <article className="shared-run" aria-label={run.kind + ' request'}>
      <div className="run-heading">
        <strong>{run.question}</strong>
        <span className={'run-status status-' + run.status}>{run.status}</span>
      </div>
      {run.error && <p className="research-error">{run.error}</p>}
      {run.status === 'uncertain' && (
        <p className="metadata-label">
          The provider’s result is uncertain. This request will not be sent again
          automatically.
        </p>
      )}
      {run.status === 'running' && (
        <button
          className="text-button"
          disabled={canceling === run.id}
          onClick={() => onCancel(run)}
        >
          {canceling === run.id ? 'Canceling…' : 'Cancel request'}
        </button>
      )}
      {run.status === 'completed' && run.answer && (
        <AnswerContent
          answer={run.answer}
          pageCount={pageCount}
          onNavigate={onNavigate}
        />
      )}
    </article>
  );
}

function SharedAssistantPanel({
  room,
  context,
  pdfDocument,
  indexing,
  onNavigate,
  onSave,
  notice,
  showThemeToggle = false,
}: SharedAssistantProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'ask' | 'discuss'>('ask');
  const [externalEnabled, setExternalEnabled] = useState(false);
  const [externalQuery, setExternalQuery] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingRun | null>(null);
  const [latestRun, setLatestRun] = useState<AiRun | null>(null);
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [localEvidence, setLocalEvidence] = useState<Evidence[]>([]);
  const [canceling, setCanceling] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const delivery = useRef<Promise<void> | null>(null);
  const messageId = useRef<string | null>(null);
  const roomId = room.state.room.id;
  const documentId = context.documentId;
  const selection = context.selection;

  useEffect(() => {
    const current = ++generation.current;
    void room.client
      .request<ServiceStatus>('/health')
      .then((health) => {
        if (generation.current === current) setStatus(health);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) {
          setError(
            reason instanceof Error ? reason.message : 'AI service is unavailable.',
          );
        }
      });
    return () => {
      generation.current += 1;
    };
  }, [room.client, roomId, documentId]);

  useEffect(() => {
    if (definitionOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [definitionOpen]);

  const deliver = (request: PendingRun): Promise<void> => {
    if (delivery.current) return delivery.current;
    const current = generation.current;
    const task = (async () => {
      if (request.roomId !== roomId || request.documentId !== documentId) return;
      setBusy(true);
      setError('');
      try {
        const run = await room.client.request<AiRun>(`/rooms/${roomId}/runs`, {
          method: 'POST',
          body: JSON.stringify(request.input),
        });
        if (generation.current !== current) return;
        setLatestRun(run);
        setPending(null);
        if (request.input.kind === 'definition') setDefinitionId(run.id);
        await room.refresh();
      } catch (reason) {
        if (generation.current === current) {
          setError(
            reason instanceof Error ? reason.message : 'Request delivery failed.',
          );
        }
      } finally {
        if (generation.current === current) setBusy(false);
        delivery.current = null;
      }
    })();
    delivery.current = task;
    return task;
  };

  const requestAnswer = (kind: RunInput['kind'], question: string): void => {
    if (busy || pending || !question.trim() || status?.configured === false) return;
    const current = generation.current;
    const capturedRoom = roomId;
    const capturedDocument = documentId;
    const capturedSelection = kind === 'guide' ? null : selection;
    const capturedExternal = externalEnabled ? externalQuery.trim() || null : null;
    if (externalEnabled && !capturedExternal) {
      setError('Enter a separate external search query, or turn off outside search.');
      return;
    }
    if (
      room.state.room.documentId !== capturedDocument ||
      (capturedSelection && capturedSelection.documentId !== capturedDocument)
    ) {
      setError('Open this workspace’s paper before sending a question.');
      return;
    }
    setBusy(true);
    setError('');
    void (async () => {
      let image: string | null = null;
      if (capturedSelection?.kind === 'region') {
        if (!pdfDocument)
          throw new Error('Wait for the PDF before asking about a region.');
        image = await captureRegion(pdfDocument, capturedSelection);
      }
      if (generation.current !== current) return;
      const input = runInputSchema.parse({
        requestId: crypto.randomUUID(),
        question,
        kind,
        selection: capturedSelection,
        image,
        externalQuery: capturedExternal,
      });
      const request = { roomId: capturedRoom, documentId: capturedDocument, input };
      setPending(request);
      await deliver(request);
    })().catch((reason: unknown) => {
      if (generation.current === current) {
        setError(
          reason instanceof Error ? reason.message : 'Could not prepare this question.',
        );
        setBusy(false);
      }
    });
  };

  const sendDiscussion = (): void => {
    if (busy || !query.trim()) return;
    const current = generation.current;
    const id = messageId.current ?? crypto.randomUUID();
    messageId.current = id;
    setBusy(true);
    setError('');
    void room.client
      .request(`/rooms/${roomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ id, text: query.trim() }),
      })
      .then(async () => {
        if (generation.current !== current) return;
        messageId.current = null;
        setQuery('');
        await room.refresh();
      })
      .catch((reason: unknown) => {
        if (generation.current === current) {
          setError(
            reason instanceof Error ? reason.message : 'Could not send the message.',
          );
        }
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
  };

  const cancelRun = (run: AiRun): void => {
    const current = generation.current;
    setCanceling(run.id);
    void room.client
      .request<AiRun>(`/rooms/${roomId}/runs/${run.id}/cancel`, {
        method: 'POST',
      })
      .then(async (cancelled) => {
        if (generation.current !== current) return;
        setLatestRun(cancelled);
        await room.refresh();
      })
      .catch((reason: unknown) => {
        if (generation.current === current) {
          setError(
            reason instanceof Error ? reason.message : 'Could not cancel the request.',
          );
        }
      })
      .finally(() => {
        if (generation.current === current) setCanceling(null);
      });
  };

  const runs =
    latestRun && !room.state.runs.some((run) => run.id === latestRun.id)
      ? [...room.state.runs, latestRun]
      : room.state.runs;
  const definition = runs.find((run) => run.id === definitionId);
  const shownRuns = new Set(
    room.state.messages
      .filter((message) => message.role === 'assistant' && message.answer !== null)
      .map((message) => message.runId),
  );
  const disabled = busy || Boolean(pending) || status?.configured === false;

  return (
    <aside className="assistant-panel" aria-label="Reading companion">
      <header className="panel-header">
        <div className="panel-heading-row">
          <div className="eyebrow">
            <span className="status-dot" /> SHARED READING COMPANION
          </div>
          {showThemeToggle && <ThemeToggle />}
        </div>
        <h2>Think through it together.</h2>
        <p>Questions, discussion and sources are shared with this room.</p>
      </header>
      <div className="panel-scroll">
        <div className="mode-note">
          <Sparkles size={15} />
          {status?.configured
            ? `${status.provider} · ${status.model}`
            : 'AI setup pending'}
        </div>
        {status?.configured === false && (
          <p className="research-error" role="status">
            AI is not configured. The service needs an Astra API key before it can
            answer. Shared discussion and local passage search remain available.
          </p>
        )}
        <section className="selection-card">
          <div className="section-label">
            <Quote size={14} /> YOUR SELECTION
          </div>
          <p className={selection ? 'selection-quote' : 'muted'}>
            {selection
              ? selection.quote || 'Selected equation or figure region'
              : 'Select text or draw a region to include it with your question.'}
          </p>
          {selection && (
            <div className="selection-actions">
              <button
                className="text-button"
                onClick={() => onNavigate(selection.pageIndex)}
              >
                Page {selection.pageIndex + 1}
                <CornerUpRight size={13} />
              </button>
              <button className="text-button" onClick={onSave}>
                <Highlighter size={14} /> Save highlight
              </button>
              {selection.quote && (
                <>
                  <button
                    className="text-button"
                    disabled={indexing}
                    onClick={() => {
                      setLocalEvidence(findEvidence(selection.quote, context.pages));
                    }}
                  >
                    <Search size={13} /> Find in paper
                  </button>
                  <button
                    className="text-button"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setDefinitionId(null);
                      setDefinitionOpen(true);
                    }}
                  >
                    Expand definition
                  </button>
                </>
              )}
              {selection.kind === 'region' && (
                <p className="metadata-label">
                  A cropped image will accompany your next AI question.
                </p>
              )}
            </div>
          )}
        </section>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
        {pending && !busy && (
          <div className="request-retry">
            <p>Delivery needs confirmation: {pending.input.question}</p>
            <button
              className="text-button"
              onClick={() => {
                void deliver(pending);
              }}
            >
              Retry delivery with the same request ID
            </button>
          </div>
        )}
        {localEvidence.map((item) => (
          <article className="evidence-card" key={item.pageIndex}>
            <div className="evidence-origin">This paper · matching passage</div>
            <p>{item.excerpt}</p>
            <button className="citation" onClick={() => onNavigate(item.pageIndex)}>
              Page {item.pageIndex + 1}
              <CornerUpRight size={13} />
            </button>
          </article>
        ))}
        <button
          className="guide-button"
          disabled={disabled || indexing}
          onClick={() => {
            requestAnswer(
              'guide',
              'Create a reading guide to this paper with its central claims, ' +
                'definitions, assumptions, and a suggested reading order. ' +
                'Cite the source for each point.',
            );
          }}
        >
          <BookOpen size={15} /> Create reading guide
        </button>
        <section
          className="shared-conversation"
          aria-label="Shared conversation"
          aria-live="polite"
        >
          {room.state.messages.length === 0 && (
            <p className="muted small">
              Start the shared conversation. Everyone in this room sees the same
              answers.
            </p>
          )}
          {room.state.messages.map((message) => (
            <article
              key={message.id}
              className={'shared-message message-' + message.role}
            >
              <div className="message-author">
                {message.authorName}
                <span>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {message.answer ? (
                <AnswerContent
                  answer={message.answer}
                  pageCount={room.state.room.pageCount}
                  onNavigate={onNavigate}
                />
              ) : (
                <p>{message.text}</p>
              )}
            </article>
          ))}
          {runs
            .filter((run) => !shownRuns.has(run.id))
            .map((run) => (
              <SharedRunCard
                key={run.id}
                run={run}
                canceling={canceling}
                onCancel={cancelRun}
                pageCount={room.state.room.pageCount}
                onNavigate={onNavigate}
              />
            ))}
        </section>
      </div>
      <form
        className="composer shared-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === 'discuss') sendDiscussion();
          else requestAnswer('question', query);
        }}
      >
        <div className="composer-tabs" aria-label="Message type">
          <button
            type="button"
            aria-pressed={mode === 'ask'}
            onClick={() => setMode('ask')}
          >
            <Sparkles size={13} /> Ask AI
          </button>
          <button
            type="button"
            aria-pressed={mode === 'discuss'}
            onClick={() => setMode('discuss')}
          >
            <MessageSquare size={13} /> Discuss
          </button>
        </div>
        <label className="sr-only" htmlFor="shared-question">
          {mode === 'ask' ? 'Ask about this paper' : 'Message your reading group'}
        </label>
        <textarea
          id="shared-question"
          value={query}
          maxLength={8000}
          rows={3}
          onChange={(event) => {
            setQuery(event.target.value);
            messageId.current = null;
          }}
          placeholder={
            mode === 'ask'
              ? 'Ask about the paper or your selection…'
              : 'Share a thought with the reading group…'
          }
        />
        {mode === 'ask' && (
          <div className="external-options">
            <label>
              <input
                type="checkbox"
                checked={externalEnabled}
                onChange={(event) => setExternalEnabled(event.target.checked)}
              />
              Search outside the paper for this request
            </label>
            {externalEnabled && (
              <input
                aria-label="External source search"
                value={externalQuery}
                maxLength={500}
                placeholder="Enter the topic to search externally"
                required
                onChange={(event) => setExternalQuery(event.target.value)}
              />
            )}
          </div>
        )}
        <div className="composer-footer">
          <span>Shared with the room</span>
          <button
            type="submit"
            className="send-button"
            aria-label={mode === 'ask' ? 'Send AI question' : 'Send discussion message'}
            disabled={!query.trim() || (mode === 'ask' ? disabled : busy)}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
      <dialog
        ref={dialog}
        className="definition-dialog"
        onClose={() => setDefinitionOpen(false)}
      >
        <button
          className="icon-button definition-close"
          aria-label="Close definition"
          onClick={() => setDefinitionOpen(false)}
        >
          <X size={18} />
        </button>
        <h2>Expand a definition</h2>
        <p className="selection-quote">{selection?.quote}</p>
        <p className="muted small">
          Ask for the paper’s use of this term. Sources are labeled by origin.
        </p>
        {definition ? (
          <SharedRunCard
            run={definition}
            canceling={canceling}
            onCancel={cancelRun}
            pageCount={room.state.room.pageCount}
            onNavigate={onNavigate}
          />
        ) : (
          <button
            className="primary-button"
            disabled={disabled || !selection?.quote}
            onClick={() => {
              requestAnswer(
                'definition',
                'Define this selection in the context of the paper. ' +
                  'Distinguish the authors’ definition from outside terminology ' +
                  'and cite evidence: ' +
                  (selection?.quote ?? '').slice(0, 7000),
              );
            }}
          >
            Explain selected text
          </button>
        )}
        {error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </aside>
  );
}

export function AssistantPanel(props: AssistantPanelProps): React.JSX.Element {
  if (props.room && props.context)
    return (
      <SharedAssistantPanel
        {...props}
        room={props.room}
        context={props.context}
        key={props.room.state.room.id + ':' + props.context.documentId}
      />
    );
  return <LocalAssistantPanel {...props} />;
}
