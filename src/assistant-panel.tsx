import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
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
import { anchorSchema, findEvidence, pointToViewport } from './document';
import { ThemeToggle } from './theme-toggle';
import { AnswerContent } from './enhanced-reader';
import { InlineDefinition, definitionKey } from './inline-definition';
import type { DefinitionTarget } from './inline-definition';
import { ProofWorkspace, PROOF_QUESTION } from './proof-workspace';
import type { ProofRequest, ProofTarget } from './proof-workspace';
import { runInputSchema } from './workspace-contract';
import type { AssistantContext } from './bridge';
import type { Anchor, Evidence, PageBox, Transform } from './document';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RoomConnection } from './workspace-client';
import { useService } from './workspace-client';
import { useSoloContext } from './solo-context';
import { SavedContextControl } from './saved-context-control';
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
  definitionTarget?: DefinitionTarget | null;
  onCloseDefinition?: () => void;
  onDefine?: (anchor: Anchor) => void;
  proofTarget?: ProofTarget | null;
  selectionTarget?: Anchor | null;
}

function submitOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  enabled: boolean,
): void {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  if (enabled) event.currentTarget.form?.requestSubmit();
}

function LocalAssistantPanel({
  context,
  indexing,
  onNavigate,
  onSave,
  notice,
  showThemeToggle = false,
  pdfDocument,
  definitionTarget,
  onCloseDefinition,
  onDefine,
  proofTarget,
  selectionTarget,
}: AssistantPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const service = useService();
  const saved = useSoloContext(service.client, context);
  const {
    runs,
    client: soloClient,
    getGeneration,
    isCurrent,
    ensureSession,
    acceptRun,
  } = saved;
  const [health, setHealth] = useState<ServiceStatus | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [definitionRequestIds, setDefinitionRequestIds] = useState<
    Record<string, string>
  >({});
  const [definitionErrorKey, setDefinitionErrorKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'ask' | 'search'>('ask');
  const [proofOpen, setProofOpen] = useState(false);
  const [proofRunId, setProofRunId] = useState<string | null>(null);
  const handledProofTarget = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<RunInput | null>(null);
  const [canceling, setCanceling] = useState<string | null>(null);
  const inFlight = useRef(false);
  const conversation = useRef<HTMLDivElement>(null);
  const documentId = context?.documentId;
  const aiAvailable = Boolean(health?.configured && health.soloAvailable);
  const contextBlocked = saved.loading || Boolean(saved.unavailableId);
  const asking = aiAvailable && mode === 'ask';
  const selection = context?.selection;
  const suggestions = asking
    ? [
        selection ? 'Explain this selection step by step.' : 'What is the main result?',
        'Which definitions do I need to understand this paper?',
      ]
    : ['What does convolution mean here?', 'Where is semiring defined?'];

  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    setHealthChecked(false);
    void service.client
      .request<ServiceStatus>('/health')
      .then((status) => {
        if (!cancelled) setHealth(status);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      })
      .finally(() => {
        if (!cancelled) setHealthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [service.client, documentId]);

  useEffect(() => {
    setDefinitionRequestIds({});
    setDefinitionErrorKey(null);
    setProofRunId(null);
    setProofOpen(false);
    setError('');
    setPending(null);
    setBusy(false);
    setCanceling(null);
    setSubmitted('');
    setEvidence([]);
    inFlight.current = false;
  }, [saved.sessionKey]);

  const finishedCount = runs.filter((run) => run.status !== 'running').length;
  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [runs.length, finishedCount]);

  useEffect(() => {
    if (!selectionTarget) return;
    setProofOpen(false);
    if (conversation.current) conversation.current.scrollTop = 0;
  }, [selectionTarget]);

  const ask = useCallback(
    async (
      question: string,
      retry?: RunInput,
      proofRequest?: ProofRequest,
    ): Promise<void> => {
      if (
        !context ||
        !aiAvailable ||
        contextBlocked ||
        indexing ||
        !question.trim() ||
        inFlight.current
      ) {
        return;
      }
      const current = getGeneration();
      inFlight.current = true;
      setBusy(true);
      setError('');
      setDefinitionErrorKey(null);
      const capturedSelection = proofRequest?.parent
        ? null
        : (proofRequest?.selection ?? selection ?? null);
      try {
        const image =
          !retry && capturedSelection?.kind === 'region' && pdfDocument
            ? await captureRegion(pdfDocument, capturedSelection)
            : null;
        const input =
          retry ??
          runInputSchema.parse({
            requestId: crypto.randomUUID(),
            question,
            kind: proofRequest ? 'proof' : 'question',
            selection: capturedSelection,
            image,
            externalQuery: null,
            ...(proofRequest?.parent ? { proofParent: proofRequest.parent } : {}),
          });
        if (!isCurrent(current)) return;
        if (input.kind === 'definition' && input.selection) {
          const key = definitionKey(input.selection, input.externalQuery);
          setDefinitionErrorKey(key);
          setDefinitionRequestIds((current) => ({
            ...current,
            [key]: input.requestId,
          }));
        }
        const client = await ensureSession();
        if (!client || !isCurrent(current)) return;
        setPending(input);
        const run = await client.request<AiRun>('/solo/runs', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        if (!isCurrent(current)) return;
        acceptRun(run);
        if (input.kind === 'proof') {
          setProofRunId(run.id);
          setProofOpen(true);
        }
        setPending(null);
        setQuery((value) => (value.trim() === question.trim() ? '' : value));
      } catch (reason) {
        if (isCurrent(current))
          setError(
            reason instanceof Error ? reason.message : 'Could not send this question.',
          );
      } finally {
        if (isCurrent(current)) {
          setBusy(false);
          inFlight.current = false;
        }
      }
    },
    [
      acceptRun,
      aiAvailable,
      context,
      contextBlocked,
      ensureSession,
      getGeneration,
      isCurrent,
      indexing,
      pdfDocument,
      selection,
    ],
  );

  const requestProof = useCallback(
    (request: ProofRequest): void => {
      setProofOpen(true);
      if (busy || pending || contextBlocked) return;
      const anchor = request.selection ?? selection;
      const prior =
        !request.parent && !request.regenerate && anchor
          ? [...runs].reverse().find((item) => {
              const artifact = item.answer?.proofArtifact;
              return (
                item.kind === 'proof' &&
                item.status === 'completed' &&
                item.question === request.question &&
                !artifact?.parent &&
                artifact?.sourceAnchor &&
                JSON.stringify(anchorSchema.parse(artifact.sourceAnchor)) ===
                  JSON.stringify(anchorSchema.parse(anchor))
              );
            })
          : null;
      if (prior) {
        setProofRunId(prior.id);
        return;
      }
      void ask(request.question, undefined, request);
    },
    [ask, busy, contextBlocked, pending, runs, selection],
  );

  useEffect(() => {
    if (
      !proofTarget ||
      handledProofTarget.current === proofTarget.id ||
      proofTarget.anchor.documentId !== documentId ||
      !healthChecked ||
      indexing ||
      contextBlocked ||
      busy ||
      pending
    )
      return;
    handledProofTarget.current = proofTarget.id;
    setProofOpen(true);
    requestProof({ question: PROOF_QUESTION, selection: proofTarget.anchor });
  }, [
    proofTarget,
    documentId,
    healthChecked,
    indexing,
    contextBlocked,
    busy,
    aiAvailable,
    pending,
    requestProof,
  ]);

  const cancel = async (run: AiRun): Promise<void> => {
    const current = getGeneration();
    setCanceling(run.id);
    try {
      const result = await soloClient?.request<AiRun>(
        '/solo/runs/' + run.id + '/cancel',
        {
          method: 'POST',
        },
      );
      if (result && isCurrent(current)) acceptRun(result);
    } catch (reason) {
      if (isCurrent(current))
        setError(
          reason instanceof Error ? reason.message : 'Could not cancel the question.',
        );
    } finally {
      if (isCurrent(current)) setCanceling(null);
    }
  };

  const search = (text: string): void => {
    if (!context || indexing || !text.trim()) return;
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
        <h2>
          {proofOpen
            ? 'Follow the proof.'
            : asking
              ? 'Ask about this paper.'
              : 'Find it in the paper.'}
        </h2>
        <p>
          {proofOpen
            ? 'Understand the argument, one step at a time.'
            : asking
              ? 'Work through an idea without losing your place.'
              : 'Search the text and follow the evidence.'}
        </p>
        <div className="proof-panel-tabs" aria-label="Companion view">
          <button aria-pressed={!proofOpen} onClick={() => setProofOpen(false)}>
            Conversation
          </button>
          <button aria-pressed={proofOpen} onClick={() => setProofOpen(true)}>
            Proofs
          </button>
        </div>
        {context && (
          <SavedContextControl
            controller={saved}
            disabled={indexing || busy || Boolean(pending)}
          />
        )}
      </header>
      <div className="panel-scroll" ref={conversation} hidden={proofOpen}>
        <div className="mode-note">
          <BookOpen size={15} />
          <span>
            {aiAvailable ? `${health!.provider} · ${health!.model}` : 'Passage search'}
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
                  <SelectionPreview selection={selection} pdfDocument={pdfDocument} />
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
                    <button
                      className="text-button"
                      disabled={indexing || busy || Boolean(pending) || contextBlocked}
                      onClick={() =>
                        requestProof({ question: PROOF_QUESTION, selection })
                      }
                    >
                      Break down proof
                    </button>
                    {selection.quote && onDefine && (
                      <button
                        className="text-button"
                        data-define-selection
                        onClick={() => onDefine(selection)}
                      >
                        Define selection
                      </button>
                    )}
                    {selection.quote && (
                      <button
                        className="text-button"
                        disabled={indexing}
                        onClick={() => {
                          setMode('search');
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
            {!submitted && runs.length === 0 && (
              <section className="suggestions">
                <div className="section-label">START WITH A QUESTION</div>
                {suggestions.map((prompt) => (
                  <button
                    key={prompt}
                    disabled={indexing || busy || Boolean(pending) || contextBlocked}
                    onClick={() => {
                      setQuery(prompt);
                      if (asking) void ask(prompt);
                      else search(prompt);
                    }}
                  >
                    {prompt}
                    <CornerUpRight size={15} />
                  </button>
                ))}
                <p className="muted small">
                  {asking
                    ? 'Questions and relevant passages go to Astra. ' +
                      (saved.active
                        ? 'This conversation updates your saved context.'
                        : 'Save a named context to keep this conversation.')
                    : 'This mode finds matching passages. AI explanations require ' +
                      'the local Astra service or a connected reading room.'}
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
            {error && (
              <p className="research-error" role="alert">
                {error}
              </p>
            )}
            {busy && (
              <p className="notice" role="status">
                Sending to Astra…
              </p>
            )}
            {pending && !busy && (
              <div className="request-retry">
                <p>Delivery needs confirmation. Your draft is preserved.</p>
                <button
                  className="text-button"
                  onClick={() => void ask(pending.question, pending)}
                >
                  Retry delivery with the same request ID
                </button>
              </div>
            )}
            <section aria-label="Solo conversation" aria-live="polite">
              {runs.map((run) => (
                <SharedRunCard
                  key={run.id}
                  run={run}
                  canceling={canceling}
                  pageCount={context.pages.length}
                  onNavigate={onNavigate}
                  onCancel={(item) => void cancel(item)}
                  onOpenProof={(id) => {
                    setProofRunId(id);
                    setProofOpen(true);
                  }}
                />
              ))}
            </section>
          </>
        ) : (
          <div className="panel-empty">
            <BookOpen size={28} />
            <h3>Your paper, in focus.</h3>
            <p>Open a PDF to collect passages, save highlights and follow sources.</p>
          </div>
        )}
      </div>
      {proofOpen && context && (
        <ProofWorkspace
          run={
            runs.find((item) => item.id === proofRunId) ??
            [...runs].reverse().find((item) => item.kind === 'proof') ??
            null
          }
          runs={runs}
          client={soloClient}
          basePath="/solo"
          selection={selection ?? null}
          lean={health?.lean}
          configured={healthChecked ? aiAvailable : null}
          disabled={
            !aiAvailable ||
            contextBlocked ||
            indexing ||
            busy ||
            Boolean(pending) ||
            runs.some((item) => item.kind === 'proof' && item.status === 'running')
          }
          busy={busy}
          error={error || saved.error}
          pending={Boolean(pending)}
          onRequest={requestProof}
          onOpen={setProofRunId}
          onNavigate={onNavigate}
          onCancel={(run) => void cancel(run)}
          onRetry={() => {
            if (pending) void ask(pending.question, pending);
          }}
        />
      )}
      <form
        className="composer"
        hidden={proofOpen}
        onSubmit={(event) => {
          event.preventDefault();
          if (asking) void ask(query);
          else search(query);
        }}
      >
        {aiAvailable && (
          <div className="composer-tabs" aria-label="Question mode">
            <button
              type="button"
              aria-pressed={mode === 'ask'}
              onClick={() => setMode('ask')}
            >
              <Sparkles size={13} /> Ask Astra
            </button>
            <button
              type="button"
              aria-pressed={mode === 'search'}
              onClick={() => setMode('search')}
            >
              <Search size={13} /> Find passages
            </button>
          </div>
        )}
        <label className="sr-only" htmlFor="question">
          {asking ? 'Ask about this paper' : 'Search this paper'}
        </label>
        <textarea
          id="question"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) =>
            submitOnEnter(
              event,
              Boolean(context) &&
                !indexing &&
                Boolean(query.trim()) &&
                !busy &&
                !pending &&
                !contextBlocked,
            )
          }
          placeholder={
            asking
              ? 'Ask about the paper or your selection…'
              : 'Find a term or passage…'
          }
          disabled={!context}
          rows={2}
        />
        <div className="composer-footer">
          <span>
            {indexing ? 'Indexing paper…' : 'Enter to send · Shift+Enter for newline'}
          </span>
          <button
            type="submit"
            className="send-button"
            aria-label={asking ? 'Send AI question' : 'Find supporting passages'}
            disabled={
              !context ||
              indexing ||
              !query.trim() ||
              busy ||
              Boolean(pending) ||
              contextBlocked
            }
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
      {definitionTarget && onCloseDefinition && context && (
        <InlineDefinition
          key={definitionTarget.id}
          target={definitionTarget}
          runs={runs}
          requestIds={definitionRequestIds}
          pending={pending}
          busy={busy}
          indexing={indexing}
          configured={healthChecked ? aiAvailable : null}
          error={error}
          errorKey={definitionErrorKey}
          pageCount={context.pages.length}
          onRequest={(input) => void ask(input.question, input)}
          onCancel={(run) => void cancel(run)}
          onClose={onCloseDefinition}
          onNavigate={onNavigate}
        />
      )}
    </aside>
  );
}

/** Render only the selected region, bounded independently of the PDF page size. */
async function captureRegion(
  pdf: PDFDocumentProxy,
  anchor: Anchor,
  signal?: AbortSignal,
): Promise<string> {
  const page = await pdf.getPage(anchor.pageIndex + 1);
  signal?.throwIfAborted();
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
  let cancel: (() => void) | undefined;
  try {
    const render = page.render({
      canvas,
      viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -left * scale, -top * scale],
      background: '#ffffff',
    });
    cancel = () => render.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    await render.promise;
    signal?.throwIfAborted();
    const image = canvas.toDataURL('image/png');
    if (image.length > 3_000_000) {
      throw new Error('This region is too detailed. Select a smaller area and retry.');
    }
    return image;
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    canvas.width = 0;
    canvas.height = 0;
  }
}

function SelectionPreview({
  selection,
  pdfDocument,
}: {
  selection: Anchor;
  pdfDocument: PDFDocumentProxy | null | undefined;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{
    anchor: Anchor;
    pdf: PDFDocumentProxy;
    image: string | null;
    error: string;
  } | null>(null);
  const current =
    preview?.anchor === selection && preview.pdf === pdfDocument ? preview : null;

  useEffect(() => {
    if (selection.kind !== 'region' || !pdfDocument) return;
    const controller = new AbortController();
    void captureRegion(pdfDocument, selection, controller.signal)
      .then((image) => {
        if (!controller.signal.aborted)
          setPreview({ anchor: selection, pdf: pdfDocument, image, error: '' });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setPreview({
            anchor: selection,
            pdf: pdfDocument,
            image: null,
            error: 'Could not preview this area. Try selecting a smaller region.',
          });
      });
    return () => controller.abort();
  }, [selection, pdfDocument]);

  if (selection.kind === 'text' || !pdfDocument)
    return (
      <p className="selection-quote">
        {selection.quote || 'Selected equation or figure region'}
      </p>
    );
  return current?.image ? (
    <img
      className="selection-region-preview"
      src={current.image}
      alt={`Selected region from page ${selection.pageIndex + 1}`}
    />
  ) : (
    <p className="muted" role="status">
      {current?.error || 'Preparing selection preview…'}
    </p>
  );
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
  onOpenProof?: (runId: string) => void;
}

function SharedRunCard({
  run,
  canceling,
  pageCount,
  onCancel,
  onNavigate,
  onOpenProof,
}: SharedRunCardProps): React.JSX.Element {
  return (
    <article className="shared-run" aria-label={run.kind + ' request'}>
      <div className="run-heading">
        <strong>{run.question}</strong>
        <span className={'run-status status-' + run.status}>
          {run.status === 'running' ? 'Thinking…' : run.status}
        </span>
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
        <>
          <AnswerContent
            answer={run.answer}
            pageCount={pageCount}
            onNavigate={onNavigate}
          />
          {run.answer.proof && onOpenProof && (
            <button className="text-button" onClick={() => onOpenProof(run.id)}>
              Open proof walkthrough
            </button>
          )}
        </>
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
  definitionTarget,
  onCloseDefinition,
  onDefine,
  proofTarget,
  selectionTarget,
}: SharedAssistantProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'ask' | 'discuss'>('ask');
  const [externalEnabled, setExternalEnabled] = useState(false);
  const [externalQuery, setExternalQuery] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [definitionRequestIds, setDefinitionRequestIds] = useState<
    Record<string, string>
  >({});
  const [definitionErrorKey, setDefinitionErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingRun | null>(null);
  const [latestRun, setLatestRun] = useState<AiRun | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [proofRunId, setProofRunId] = useState<string | null>(null);
  const handledProofTarget = useRef<string | null>(null);
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
  const conversation = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectionTarget) return;
    setProofOpen(false);
    if (conversation.current) conversation.current.scrollTop = 0;
  }, [selectionTarget]);

  useEffect(() => {
    const current = ++generation.current;
    setHealthChecked(false);
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
      })
      .finally(() => {
        if (generation.current === current) setHealthChecked(true);
      });
    return () => {
      generation.current += 1;
    };
  }, [room.client, roomId, documentId]);

  useEffect(() => {
    if (definitionOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [definitionOpen]);

  const deliver = useCallback(
    (request: PendingRun): Promise<void> => {
      if (delivery.current) return delivery.current;
      const current = generation.current;
      const task = (async () => {
        if (request.roomId !== roomId || request.documentId !== documentId) return;
        setBusy(true);
        setError('');
        setDefinitionErrorKey(null);
        if (request.input.kind === 'definition' && request.input.selection) {
          const key = definitionKey(
            request.input.selection,
            request.input.externalQuery,
          );
          setDefinitionErrorKey(key);
          setDefinitionRequestIds((current) => ({
            ...current,
            [key]: request.input.requestId,
          }));
        }
        try {
          const run = await room.client.request<AiRun>(`/rooms/${roomId}/runs`, {
            method: 'POST',
            body: JSON.stringify(request.input),
          });
          if (generation.current !== current) return;
          setLatestRun(run);
          setPending(null);
          if (request.input.kind === 'question') {
            setQuery((current) =>
              current.trim() === request.input.question.trim() ? '' : current,
            );
          }
          if (request.input.kind === 'definition') setDefinitionId(run.id);
          if (request.input.kind === 'proof') {
            setProofRunId(run.id);
            setProofOpen(true);
          }
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
    },
    [documentId, roomId, room],
  );

  const requestAnswer = useCallback(
    (kind: RunInput['kind'], question: string, proofRequest?: ProofRequest): void => {
      if (busy || pending || !question.trim() || status?.configured === false) return;
      const current = generation.current;
      const capturedRoom = roomId;
      const capturedDocument = documentId;
      const capturedSelection =
        kind === 'guide' || proofRequest?.parent
          ? null
          : (proofRequest?.selection ?? selection);
      const capturedExternal =
        kind !== 'proof' && externalEnabled ? externalQuery.trim() || null : null;
      if (kind !== 'proof' && externalEnabled && !capturedExternal) {
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
          ...(proofRequest?.parent ? { proofParent: proofRequest.parent } : {}),
        });
        const request = { roomId: capturedRoom, documentId: capturedDocument, input };
        setPending(request);
        await deliver(request);
      })().catch((reason: unknown) => {
        if (generation.current === current) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not prepare this question.',
          );
          setBusy(false);
        }
      });
    },
    [
      busy,
      pending,
      status?.configured,
      roomId,
      documentId,
      selection,
      externalEnabled,
      externalQuery,
      room.state.room.documentId,
      pdfDocument,
      deliver,
    ],
  );

  const requestProof = useCallback(
    (request: ProofRequest): void => {
      setProofOpen(true);
      requestAnswer('proof', request.question, request);
    },
    [requestAnswer],
  );

  useEffect(() => {
    if (
      !proofTarget ||
      handledProofTarget.current === proofTarget.id ||
      proofTarget.anchor.documentId !== documentId ||
      !healthChecked ||
      indexing ||
      busy ||
      pending
    )
      return;
    handledProofTarget.current = proofTarget.id;
    setProofOpen(true);
    if (status?.configured)
      requestProof({ question: PROOF_QUESTION, selection: proofTarget.anchor });
  }, [
    proofTarget,
    documentId,
    healthChecked,
    indexing,
    busy,
    pending,
    status,
    requestProof,
  ]);

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
        <h2>{proofOpen ? 'Follow the proof.' : 'Think through it together.'}</h2>
        <p>
          {proofOpen
            ? 'Walkthroughs and Lean results are shared with this room.'
            : 'Questions, discussion and sources are shared with this room.'}
        </p>
        <div className="proof-panel-tabs" aria-label="Companion view">
          <button aria-pressed={!proofOpen} onClick={() => setProofOpen(false)}>
            Conversation
          </button>
          <button aria-pressed={proofOpen} onClick={() => setProofOpen(true)}>
            Proofs
          </button>
        </div>
      </header>
      <div className="panel-scroll" ref={conversation} hidden={proofOpen}>
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
          {selection ? (
            <SelectionPreview selection={selection} pdfDocument={pdfDocument} />
          ) : (
            <p className="muted">
              Select text or draw a region to include it with your question.
            </p>
          )}
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
              <button
                className="text-button"
                disabled={disabled || indexing}
                onClick={() => requestProof({ question: PROOF_QUESTION, selection })}
              >
                Break down proof
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
                      if (onDefine) onDefine(selection);
                      else {
                        setDefinitionId(null);
                        setDefinitionOpen(true);
                      }
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
                <>
                  <AnswerContent
                    answer={message.answer}
                    pageCount={room.state.room.pageCount}
                    onNavigate={onNavigate}
                  />
                  {message.answer.proof && message.runId && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setProofRunId(message.runId);
                        setProofOpen(true);
                      }}
                    >
                      Open proof walkthrough
                    </button>
                  )}
                </>
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
                onOpenProof={(id) => {
                  setProofRunId(id);
                  setProofOpen(true);
                }}
              />
            ))}
        </section>
      </div>
      {proofOpen && (
        <ProofWorkspace
          run={
            runs.find((item) => item.id === proofRunId) ??
            [...runs].reverse().find((item) => item.kind === 'proof') ??
            null
          }
          runs={runs}
          client={room.client}
          basePath={'/rooms/' + roomId}
          selection={selection}
          lean={status?.lean}
          configured={healthChecked ? Boolean(status?.configured) : null}
          disabled={
            disabled ||
            indexing ||
            runs.some((item) => item.kind === 'proof' && item.status === 'running')
          }
          busy={busy}
          error={error}
          pending={Boolean(pending)}
          onRequest={requestProof}
          onOpen={setProofRunId}
          onNavigate={onNavigate}
          onCancel={cancelRun}
          onRetry={() => {
            if (pending) void deliver(pending);
          }}
        />
      )}
      <form
        className="composer shared-composer"
        hidden={proofOpen}
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
          onKeyDown={(event) =>
            submitOnEnter(
              event,
              Boolean(query.trim()) && !(mode === 'ask' ? disabled : busy),
            )
          }
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
          <span>Enter to send · Shift+Enter for newline</span>
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
      {definitionTarget && onCloseDefinition && (
        <InlineDefinition
          key={definitionTarget.id}
          target={definitionTarget}
          runs={runs}
          requestIds={definitionRequestIds}
          pending={pending?.input ?? null}
          busy={busy}
          indexing={indexing}
          configured={healthChecked ? Boolean(status?.configured) : null}
          error={error}
          errorKey={definitionErrorKey}
          pageCount={room.state.room.pageCount}
          onRequest={(input) => {
            if (
              input.selection?.documentId !== documentId ||
              room.state.room.documentId !== documentId
            )
              return;
            const request = { roomId, documentId, input };
            setPending(request);
            void deliver(request);
          }}
          onCancel={cancelRun}
          onClose={onCloseDefinition}
          onNavigate={onNavigate}
        />
      )}
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
