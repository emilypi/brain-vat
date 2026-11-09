import { useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  CornerUpRight,
  Highlighter,
  Quote,
  Search,
} from 'lucide-react';
import { findEvidence } from './document';
import type { AssistantContext } from './bridge';
import type { Evidence } from './document';

interface AssistantPanelProps {
  context: AssistantContext | null;
  indexing: boolean;
  onNavigate: (pageIndex: number) => void;
  onSave: () => void;
  notice: string;
}

export function AssistantPanel({
  context,
  indexing,
  onNavigate,
  onSave,
  notice,
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
        <div className="eyebrow">
          <span className="status-dot" /> READING COMPANION
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
