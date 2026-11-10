import { CornerUpRight, ExternalLink } from 'lucide-react';
import {
  safeExternalUrl,
  sourceOriginLabel,
  validateAnswerEvidence,
} from './source-links';
import type { PaperPassage } from './document';
import type { AiRun, GeneratedAnswer, SourceEvidence } from './workspace-contract';
import './research.css';

interface EvidenceCardProps {
  source: SourceEvidence;
  onNavigate: (pageIndex: number) => void;
}

export function EvidenceCard({
  source,
  onNavigate,
}: EvidenceCardProps): React.JSX.Element {
  const url = safeExternalUrl(source.url);
  return (
    <article className="research-source">
      <div className="evidence-origin">{sourceOriginLabel(source.origin)}</div>
      <strong>{source.title}</strong>
      {source.availability === 'metadataOnly' ? (
        <p className="metadata-label">
          Metadata only · source content was not retrieved.
        </p>
      ) : (
        <p>{source.excerpt}</p>
      )}
      {source.origin === 'thisPaper' && source.pageIndex !== null && (
        <button className="citation" onClick={() => onNavigate(source.pageIndex ?? 0)}>
          Page {source.pageIndex + 1}
          <CornerUpRight size={13} />
        </button>
      )}
      {url && (
        <a className="citation" href={url} target="_blank" rel="noreferrer">
          Open source
          <ExternalLink size={13} />
        </a>
      )}
    </article>
  );
}

interface AnswerContentProps {
  answer: GeneratedAnswer;
  pageCount: number;
  onNavigate: (pageIndex: number) => void;
}

export function AnswerContent({
  answer,
  pageCount,
  onNavigate,
}: AnswerContentProps): React.JSX.Element {
  const error = validateAnswerEvidence(answer, pageCount);
  if (error)
    return (
      <p className="research-error" role="alert">
        {error} The generated answer is withheld until its citations can be resolved.
      </p>
    );
  const sources = new Map(answer.evidence.map((item) => [item.id, item]));
  return (
    <div className="generated-answer">
      {answer.blocks.map((block, index) => (
        <section key={index} className="answer-block">
          {block.heading && <h3>{block.heading}</h3>}
          <p>{block.text}</p>
          {block.evidenceIds.length > 0 ? (
            <details>
              <summary>Sources ({block.evidenceIds.length})</summary>
              {block.evidenceIds.map((id) => {
                const source = sources.get(id);
                return source ? (
                  <EvidenceCard key={id} source={source} onNavigate={onNavigate} />
                ) : null;
              })}
            </details>
          ) : (
            <p className="metadata-label">No source attached to this block.</p>
          )}
        </section>
      ))}
      <p className="answer-model">
        Generated with {answer.model}. Check the linked evidence.
      </p>
    </div>
  );
}

interface EnhancedReaderProps {
  pages: PaperPassage[];
  guide: AiRun | null;
  canGenerate?: boolean;
  onNavigate: (pageIndex: number) => void;
}

export function EnhancedReader({
  pages,
  guide,
  canGenerate = false,
  onNavigate,
}: EnhancedReaderProps): React.JSX.Element {
  const pageCount = Math.max(0, ...pages.map((page) => page.pageIndex + 1));
  return (
    <section className="enhanced-reader" aria-label="Enhanced reading mode">
      <header>
        <div className="eyebrow">ENHANCED READING</div>
        <h2>Follow the argument.</h2>
        <p>Return to the original page whenever you need its notation or layout.</p>
      </header>
      {guide?.status === 'completed' && guide.answer ? (
        <section className="reading-guide">
          <div className="section-label">GENERATED GUIDE · SAVED VERSION</div>
          <p className="metadata-label">
            Created {new Date(guide.createdAt).toLocaleString()}. The source PDF is
            unchanged.
          </p>
          <AnswerContent
            answer={guide.answer}
            pageCount={pageCount}
            onNavigate={onNavigate}
          />
        </section>
      ) : (
        <p className="enhanced-hint">
          {guide?.status === 'running'
            ? 'The shared guide is being prepared.'
            : canGenerate
              ? 'Use Create reading guide in the companion for a sourced explanation.'
              : 'Open Workspace and create a room to request a sourced reading guide.'}
        </p>
      )}
      <div className="extracted-pages">
        {pages.map((page) => (
          <article key={page.pageIndex}>
            <button className="citation" onClick={() => onNavigate(page.pageIndex)}>
              Original page {page.pageIndex + 1}
              <CornerUpRight size={13} />
            </button>
            <p>
              {page.text ||
                'No selectable text on this page. Open the original PDF page.'}
            </p>
          </article>
        ))}
        {pages.length === 0 && <p className="muted">Extracting the paper’s text…</p>}
      </div>
    </section>
  );
}
