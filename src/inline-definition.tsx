import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AnswerContent } from './enhanced-reader';
import { runInputSchema } from './workspace-contract';
import type { Anchor } from './document';
import type { AiRun, RunInput } from './workspace-contract';

export interface DefinitionTarget {
  id: string;
  anchor: Anchor;
}

/** Scope cached meanings to the paper, page, term and explicit outside query. */
export function definitionKey(anchor: Anchor, externalQuery: string | null): string {
  return JSON.stringify([
    anchor.documentId,
    anchor.pageIndex,
    anchor.quote.trim(),
    externalQuery,
  ]);
}

export function definitionInput(
  anchor: Anchor,
  externalQuery: string | null,
): RunInput {
  return runInputSchema.parse({
    requestId: crypto.randomUUID(),
    kind: 'definition',
    selection: anchor,
    image: null,
    externalQuery,
    question:
      'Briefly explain this term in the paper: ' +
      anchor.quote.slice(0, 6500) +
      '. Use at most three short blocks. Cite the paper’s definition or usage. ' +
      'Say when the paper does not define it. Keep outside definitions in separate ' +
      'blocks with their own sources; distinguish inference from quoted evidence.',
  });
}

interface InlineDefinitionProps {
  target: DefinitionTarget;
  runs: AiRun[];
  requestIds: Record<string, string>;
  pending: RunInput | null;
  busy: boolean;
  indexing: boolean;
  configured: boolean | null;
  error: string;
  errorKey: string | null;
  pageCount: number;
  onRequest: (input: RunInput) => void;
  onCancel: (run: AiRun) => void;
  onClose: () => void;
  onNavigate: (pageIndex: number) => void;
}

/** Interactive definition popover; stays outside the collapsed companion drawer. */
export function InlineDefinition({
  target,
  runs,
  requestIds,
  pending,
  busy,
  indexing,
  configured,
  error,
  errorKey,
  pageCount,
  onRequest,
  onCancel,
  onClose,
  onNavigate,
}: InlineDefinitionProps): React.JSX.Element {
  const card = useRef<HTMLElement>(null);
  const attempted = useRef(false);
  const focused = useRef(false);
  const heading = useId();
  const [mode, setMode] = useState<'paper' | 'outside'>('paper');
  const [query, setQuery] = useState(target.anchor.quote.trim().slice(0, 500));
  const [searched, setSearched] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, visible: false });
  const paperKey = definitionKey(target.anchor, null);
  const key = definitionKey(target.anchor, mode === 'paper' ? null : searched);
  const hasRequest = mode === 'paper' || searched !== null;
  const run =
    mode === 'paper' || searched !== null
      ? runs.find((item) => item.requestId === requestIds[key])
      : undefined;
  const matchingPending =
    hasRequest &&
    pending?.kind === 'definition' &&
    pending.selection &&
    definitionKey(pending.selection, pending.externalQuery) === key
      ? pending
      : null;
  const enabled = configured === true && !indexing && !busy && !pending;

  useEffect(() => {
    if (attempted.current || requestIds[paperKey] || !enabled) return;
    attempted.current = true;
    onRequest(definitionInput(target.anchor, null));
  }, [enabled, onRequest, paperKey, requestIds, target.anchor]);

  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!position.visible || focused.current) return;
    focused.current = true;
    card.current?.focus({ preventScroll: true });
  }, [position.visible]);

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const element = event.target;
      if (
        element instanceof Element &&
        !card.current?.contains(element) &&
        !element.closest('[data-define-selection]')
      )
        onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    let frame = 0;
    const page = document.querySelector<HTMLElement>(
      `.pdf-page[data-page-index="${target.anchor.pageIndex}"]`,
    );
    const stage = page?.closest('.continuous-pages');
    const update = (): void => {
      frame = 0;
      if (!page || !stage || !card.current) return;
      const marks = [...page.querySelectorAll('.highlight-layer .selected')].map(
        (element) => element.getBoundingClientRect(),
      );
      if (!marks.length) {
        setPosition((value) => ({ ...value, visible: false }));
        return;
      }
      const top = Math.min(...marks.map((box) => box.top));
      const bottom = Math.max(...marks.map((box) => box.bottom));
      const left = Math.min(...marks.map((box) => box.left));
      const right = Math.max(...marks.map((box) => box.right));
      const viewport = stage.getBoundingClientRect();
      const width = card.current.offsetWidth;
      const height = card.current.offsetHeight;
      const beside = right + 12 + width <= window.innerWidth - 8;
      const before = left - 12 - width >= 8;
      const x = beside ? right + 12 : before ? left - width - 12 : left;
      const y =
        beside || before
          ? top
          : bottom + height + 12 < viewport.bottom
            ? bottom + 12
            : top - height - 12;
      setPosition({
        left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
        visible:
          bottom > viewport.top &&
          top < viewport.bottom &&
          right > viewport.left &&
          left < viewport.right,
      });
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    if (page) observer.observe(page);
    if (card.current) observer.observe(card.current);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [target]);

  const navigate = (pageIndex: number): void => {
    onClose();
    onNavigate(pageIndex);
  };
  return createPortal(
    <section
      ref={card}
      className="inline-definition"
      role="dialog"
      aria-modal="false"
      aria-labelledby={heading}
      tabIndex={-1}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.visible ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <span className="section-label">DEFINITION</span>
          <h2 id={heading}>{target.anchor.quote}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close inline definition"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="definition-tabs" aria-label="Definition sources">
        <button aria-pressed={mode === 'paper'} onClick={() => setMode('paper')}>
          In this paper
        </button>
        <button aria-pressed={mode === 'outside'} onClick={() => setMode('outside')}>
          Outside sources
        </button>
      </div>
      {mode === 'outside' && (
        <form
          className="definition-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (!enabled || !query.trim()) return;
            const outsideQuery = query.trim();
            setSearched(outsideQuery);
            if (!requestIds[definitionKey(target.anchor, outsideQuery)])
              onRequest(definitionInput(target.anchor, outsideQuery));
          }}
        >
          <label htmlFor={heading + '-query'}>Search terms</label>
          <div>
            <input
              id={heading + '-query'}
              maxLength={500}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" disabled={!enabled || !query.trim()}>
              Look up
            </button>
          </div>
          <p>
            Only these terms go to web search. The explanation also uses paper context.
          </p>
        </form>
      )}
      <div className="definition-body" aria-live="polite">
        {configured === null && <p className="muted">Connecting to Astra…</p>}
        {configured === false && (
          <p className="muted">
            Definitions need a configured Astra service. Open Workspace to connect.
          </p>
        )}
        {indexing && <p className="muted">Reading the paper’s text…</p>}
        {(busy || run?.status === 'running') && <p role="status">Explaining…</p>}
        {pending && !matchingPending && !busy && (
          <p className="muted">
            A request in Ask needs delivery confirmation before another can be sent.
          </p>
        )}
        {hasRequest && errorKey === key && error && (
          <p className="research-error" role="alert">
            {error}
          </p>
        )}
        {matchingPending && !busy && (
          <button className="text-button" onClick={() => onRequest(matchingPending)}>
            Retry delivery
          </button>
        )}
        {run?.status === 'running' && (
          <button className="text-button" onClick={() => onCancel(run)}>
            Cancel request
          </button>
        )}
        {run?.error && <p className="research-error">{run.error}</p>}
        {run?.status === 'uncertain' && (
          <p className="muted small">
            The outcome is uncertain. This request will not be sent again automatically.
          </p>
        )}
        {run?.status === 'completed' && run.answer && (
          <AnswerContent
            answer={run.answer}
            pageCount={pageCount}
            onNavigate={navigate}
            showOrigins
          />
        )}
        {!busy &&
          !pending &&
          enabled &&
          hasRequest &&
          ((errorKey === key && error) ||
            run?.status === 'failed' ||
            run?.status === 'cancelled') && (
            <button
              className="text-button"
              onClick={() =>
                onRequest(
                  definitionInput(target.anchor, mode === 'paper' ? null : searched),
                )
              }
            >
              Try a new explanation
            </button>
          )}
      </div>
    </section>,
    document.body,
  );
}
