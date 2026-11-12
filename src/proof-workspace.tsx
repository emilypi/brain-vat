import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CornerUpRight } from 'lucide-react';
import { EvidenceCard } from './enhanced-reader';
import { renderLeanProof } from './proof';
import type { LeanStatus, ProofCheck, ProofParent } from './proof';
import type { AiRun } from './workspace-contract';
import type { Anchor } from './document';
import type { WorkspaceClient } from './workspace-client';
import './proof.css';

export interface ProofTarget {
  id: string;
  anchor: Anchor;
}

export interface ProofRequest {
  question: string;
  parent?: ProofParent;
  selection?: Anchor;
  regenerate?: boolean;
}

export const PROOF_QUESTION =
  'Break down the justification of the highlighted proof or claim. Give a concise ' +
  'summary, explicit assumptions, step-by-step reasoning, Lean tactics, and ' +
  'expandable prerequisites. Identify missing steps and formalization gaps.';

interface ProofWorkspaceProps {
  run: AiRun | null;
  runs: AiRun[];
  client: WorkspaceClient | null;
  basePath: string;
  selection: Anchor | null;
  lean: LeanStatus | undefined;
  configured: boolean | null;
  disabled: boolean;
  busy: boolean;
  error: string;
  pending: boolean;
  onRequest: (request: ProofRequest) => void;
  onOpen: (runId: string) => void;
  onNavigate: (pageIndex: number) => void;
  onCancel: (run: AiRun) => void;
  onRetry: () => void;
}

const checkLabels: Record<ProofCheck['status'], string> = {
  running: 'Checking with Lean…',
  checked: 'Formal statement checked',
  incomplete: 'Incomplete proof',
  failed: 'Lean check failed',
  unavailable: 'Lean unavailable',
  cancelled: 'Lean check cancelled',
};

/** A proof-specific view of the same scoped conversation and its server checks. */
export function ProofWorkspace({
  run,
  runs,
  client,
  basePath,
  selection,
  lean,
  configured,
  disabled,
  busy,
  error,
  pending,
  onRequest,
  onOpen,
  onNavigate,
  onCancel,
  onRetry,
}: ProofWorkspaceProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const [question, setQuestion] = useState('');
  const [storedCheck, setCheck] = useState<ProofCheck | null>(null);
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const answer = run?.answer;
  const proof = answer?.proof;
  const artifact = answer?.proofArtifact;
  const runId = run?.id;
  const sourceHash = artifact?.sourceHash;
  const check =
    storedCheck?.runId === runId && storedCheck?.sourceHash === sourceHash
      ? storedCheck
      : null;
  const path = runId ? `${basePath}/runs/${runId}/proof-check` : null;
  const proofRuns = runs.filter((item) => item.kind === 'proof');
  const activeStep = proof?.steps[stepIndex];
  const goals = check?.steps.find((item) => item.stepId === activeStep?.id);
  const source =
    artifact?.renderedSource !== undefined
      ? artifact.renderedSource
      : proof
        ? renderLeanProof(proof)
        : null;
  const canCheck = !check || check.status === 'unavailable';
  const terminalCheck = check && check.status !== 'running' && !canCheck;
  const missingGoalsMessage = !source
    ? 'No formal statement is available for Lean to inspect.'
    : check?.status === 'running'
      ? 'Lean is checking this proof; tactic states will appear when available.'
      : terminalCheck
        ? 'This check did not record a tactic state for this step.'
        : 'No measured tactic state yet. Use Check with Lean to inspect it.';
  const parent = artifact?.parent;
  const parentRun = parent ? runs.find((item) => item.id === parent.runId) : null;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setStepIndex(0);
    setQuestion('');
  }, [runId]);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setCheck(null);
    setCheckError('');
    setChecking(false);
    if (!client || !path || !sourceHash) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingForAutomaticCheck = 0;
    const poll = async (): Promise<void> => {
      try {
        const value = await client.request<ProofCheck | null>(path, {
          signal: controller.signal,
        });
        if (current !== generation.current) return;
        if (value && (value.runId !== runId || value.sourceHash !== sourceHash)) {
          throw new Error('This check belongs to another proof revision.');
        }
        setCheck(value);
        setCheckError('');
        if (
          value?.status === 'running' ||
          (!value && lean?.available && waitingForAutomaticCheck++ < 10)
        )
          timer = setTimeout(() => void poll(), 1000);
      } catch (reason) {
        if (current === generation.current && !controller.signal.aborted)
          setCheckError(
            reason instanceof Error ? reason.message : 'Check unavailable.',
          );
      }
    };
    void poll();
    return () => {
      generation.current += 1;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, path, sourceHash, runId, reload, lean?.available]);

  const updateCheck = async (cancel: boolean): Promise<void> => {
    if (!client || !path || !sourceHash || checking) return;
    const current = generation.current;
    setChecking(true);
    setCheckError('');
    try {
      const value = await client.request<ProofCheck>(path + (cancel ? '/cancel' : ''), {
        method: 'POST',
        body: JSON.stringify({ sourceHash }),
      });
      if (current !== generation.current) return;
      if (value.runId !== runId || value.sourceHash !== sourceHash)
        throw new Error('This check belongs to another proof revision.');
      setCheck(value);
      if (value.status === 'running') setReload((value) => value + 1);
    } catch (reason) {
      if (current === generation.current)
        setCheckError(reason instanceof Error ? reason.message : 'Check unavailable.');
    } finally {
      if (current === generation.current) setChecking(false);
    }
  };

  const expand = (id: string): void => {
    if (!run || !proof) return;
    const prerequisite = proof.prerequisites.find((item) => item.id === id);
    if (!prerequisite) return;
    const prior = [...runs]
      .reverse()
      .find(
        (item) =>
          item.status === 'completed' &&
          item.answer?.proofArtifact?.parent?.runId === run.id &&
          item.answer.proofArtifact.parent.prerequisiteId === id,
      );
    if (prior) onOpen(prior.id);
    else
      onRequest({
        question:
          'Explain the prerequisite “' +
          prerequisite.title +
          '”. Give a ' +
          'summary and a step-by-step proof or derivation, including its own ' +
          'prerequisites and the connection to the parent argument.',
        parent: { runId: run.id, prerequisiteId: id },
      });
  };

  const moveStep = (index: number): void => {
    setStepIndex(index);
    heading.current?.focus({ preventScroll: true });
  };

  return (
    <section className="proof-workspace" aria-label="Proof workspace">
      <div className="proof-navigation">
        {parentRun && (
          <button className="text-button" onClick={() => onOpen(parentRun.id)}>
            <ArrowLeft size={14} /> Back to parent proof
          </button>
        )}
        {proofRuns.length > 0 && (
          <label>
            <span className="sr-only">Proof history</span>
            <select
              value={runId ?? ''}
              onChange={(event) => onOpen(event.target.value)}
            >
              {!runId && <option value="">Choose a walkthrough</option>}
              {proofRuns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.answer?.proof?.title ?? item.question.slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
        )}
        {selection && (
          <button
            className="text-button"
            disabled={disabled}
            onClick={() => onRequest({ question: PROOF_QUESTION, selection })}
          >
            {run ? 'Break down current selection' : 'Break down proof'}
          </button>
        )}
      </div>
      {error && (
        <p className="research-error" role="alert">
          {error}
        </p>
      )}
      {configured === false && (
        <p className="muted">
          New proof explanations need a configured Astra service. Open Workspace to
          connect.
        </p>
      )}
      {pending && !busy && (
        <div className="request-retry">
          <p>Delivery needs confirmation. The original request is preserved.</p>
          <button className="text-button" onClick={onRetry}>
            Retry delivery
          </button>
        </div>
      )}
      {busy && <p role="status">Preparing the walkthrough…</p>}
      {!run && !busy && (
        <p className="muted">
          Highlight a proof, claim, equation or figure, then choose Break down proof.
          You can also ask about a result or prerequisite below.
        </p>
      )}
      {run?.status === 'running' && (
        <div aria-live="polite">
          <p>Building a summary and Lean proof proposal…</p>
          <button className="text-button" onClick={() => onCancel(run)}>
            Cancel proof request
          </button>
        </div>
      )}
      {run?.error && (
        <p className="research-error" role="alert">
          {run.error}
        </p>
      )}
      {run?.status === 'uncertain' && (
        <p className="muted">The model outcome is uncertain; it will not be resent.</p>
      )}
      {run?.status === 'completed' && !proof && (
        <p className="muted">This answer has no structured proof walkthrough.</p>
      )}
      {proof && answer && run && (
        <>
          <header className="proof-summary">
            <div className="section-label">PROOF WALKTHROUGH</div>
            <h2>{proof.title}</h2>
            <p>{proof.summary}</p>
            {artifact?.sourceAnchor && (
              <button
                className="citation"
                onClick={() => onNavigate(artifact.sourceAnchor!.pageIndex)}
              >
                Highlighted passage · page {artifact.sourceAnchor.pageIndex + 1}
                <CornerUpRight size={13} />
              </button>
            )}
          </header>
          <details className="proof-context">
            <summary>Claim, interpretation and assumptions</summary>
            <h3>Claim</h3>
            <p>{proof.claim}</p>
            <h3>Interpretation of the highlighted passage</h3>
            <p>{proof.interpretation}</p>
            {artifact?.sourceAnchor?.kind === 'region' && (
              <p className="metadata-label">
                This is the model’s reading of the selected image. Check its notation.
              </p>
            )}
            <h3>Assumptions</h3>
            {proof.assumptions.length ? (
              <ul>
                {proof.assumptions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>No additional assumptions were listed.</p>
            )}
            {proof.statement && (
              <>
                <h3>Proposed formal statement</h3>
                <pre>
                  <code>{proof.statement}</code>
                </pre>
              </>
            )}
          </details>
          {proof.gaps.length > 0 && (
            <section className="proof-gaps" aria-label="Formalization gaps">
              <h3>What is still missing</h3>
              <ul>
                {proof.gaps.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="proof-verification" aria-label="Lean verification">
            <div
              className={'proof-status proof-status-' + (check?.status ?? 'proposed')}
              role="status"
            >
              {check ? checkLabels[check.status] : 'Proposed · not checked'}
            </div>
            {check && <p>{check.message}</p>}
            {check?.status === 'checked' && (
              <p className="metadata-label">
                Lean checked this formal statement. Its correspondence to the paper
                still needs review.
              </p>
            )}
            {check && artifact?.renderedSource === undefined && (
              <p className="metadata-label">
                This older result did not save its exact Lean source. The code below is
                reconstructed; the recorded check applies to its original source hash
                and toolchain versions.
              </p>
            )}
            {terminalCheck && (
              <p className="metadata-label">
                Create a new walkthrough to revise this proof.
              </p>
            )}
            {!source && (
              <p className="muted">
                No formal statement is available yet; the explanation remains informal.
              </p>
            )}
            {lean && !lean.available && <p className="muted">{lean.message}</p>}
            {checkError && (
              <p className="research-error" role="alert">
                {checkError}
              </p>
            )}
            {source && artifact && (
              <div className="proof-check-actions">
                {check?.status === 'running' ? (
                  <button
                    className="text-button"
                    disabled={checking}
                    onClick={() => void updateCheck(true)}
                  >
                    Cancel Lean check
                  </button>
                ) : canCheck ? (
                  <button
                    className="text-button"
                    disabled={checking || !client}
                    onClick={() => void updateCheck(false)}
                  >
                    {checking ? 'Requesting check…' : 'Check with Lean'}
                  </button>
                ) : null}
                {checkError && (
                  <button
                    className="text-button"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Refresh check
                  </button>
                )}
              </div>
            )}
            {check && (
              <details>
                <summary>Check details</summary>
                <p className="metadata-label">
                  Lean {check.leanVersion} · Mathlib {check.mathlibVersion}
                </p>
                <p className="metadata-label">Source {check.sourceHash.slice(0, 16)}</p>
                {check.axioms.length > 0 && <p>Axioms: {check.axioms.join(', ')}</p>}
                {check.diagnostics.map((item, index) => (
                  <p className="proof-diagnostic" key={index}>
                    <strong>{item.severity}</strong>
                    {item.line !== null && ` · line ${item.line + 1}`}
                    {' · '}
                    {item.message}
                  </p>
                ))}
              </details>
            )}
          </section>
          {activeStep && (
            <section className="proof-step" aria-label="Current proof step">
              <nav className="proof-step-controls" aria-label="Proof steps">
                <button
                  className="icon-button"
                  aria-label="Previous proof step"
                  disabled={stepIndex === 0}
                  onClick={() => moveStep(stepIndex - 1)}
                >
                  <ArrowLeft size={16} />
                </button>
                <label>
                  <span className="sr-only">Proof step</span>
                  <select
                    value={stepIndex}
                    onChange={(event) => moveStep(Number(event.target.value))}
                  >
                    {proof.steps.map((step, index) => (
                      <option key={step.id} value={index}>
                        {index + 1} / {proof.steps.length} · {step.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="icon-button"
                  aria-label="Next proof step"
                  disabled={stepIndex === proof.steps.length - 1}
                  onClick={() => moveStep(stepIndex + 1)}
                >
                  <ArrowRight size={16} />
                </button>
              </nav>
              <h3 ref={heading} tabIndex={-1}>
                {stepIndex + 1}. {activeStep.title}
              </h3>
              <p>{activeStep.explanation}</p>
              <details className="proof-lean-detail">
                <summary>Lean tactic and goals</summary>
                <h4>Tactic proposal</h4>
                <pre>
                  <code>{activeStep.tactic ?? 'sorry -- not formalized'}</code>
                </pre>
                {goals ? (
                  <>
                    <h4>Before · observed by Lean</h4>
                    <pre>
                      {goals.before.join('\n\n') || 'No goals at this position.'}
                    </pre>
                    <h4>After · observed by Lean</h4>
                    <pre>
                      {goals.after.join('\n\n') || 'No goals at this position.'}
                    </pre>
                    <p className="metadata-label">
                      Closing one focused goal does not establish the whole proof.
                    </p>
                  </>
                ) : (
                  <p className="muted">{missingGoalsMessage}</p>
                )}
              </details>
              {activeStep.evidenceIds.length > 0 && (
                <details>
                  <summary>Step sources ({activeStep.evidenceIds.length})</summary>
                  {activeStep.evidenceIds.map((id) => {
                    const source = answer.evidence.find((item) => item.id === id);
                    return source ? (
                      <EvidenceCard key={id} source={source} onNavigate={onNavigate} />
                    ) : null;
                  })}
                </details>
              )}
              {activeStep.prerequisiteIds.length > 0 && (
                <div className="proof-step-needs">
                  <span className="section-label">THIS STEP USES</span>
                  {activeStep.prerequisiteIds.map((id) => {
                    const prerequisite = proof.prerequisites.find(
                      (item) => item.id === id,
                    );
                    return prerequisite ? (
                      <button
                        key={id}
                        className="text-button"
                        disabled={disabled}
                        onClick={() => expand(id)}
                      >
                        Explain {prerequisite.title}
                        <ArrowRight size={13} />
                      </button>
                    ) : null;
                  })}
                </div>
              )}
            </section>
          )}
          {proof.prerequisites.length > 0 && (
            <details className="proof-prerequisites">
              <summary>Prerequisites ({proof.prerequisites.length})</summary>
              {proof.prerequisites.map((item) => (
                <article key={item.id}>
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() => expand(item.id)}
                  >
                    Walk through {item.title}
                  </button>
                </article>
              ))}
            </details>
          )}
          {source && (
            <details className="proof-source">
              <summary>Complete Lean proposal</summary>
              <pre>
                <code>{source.code}</code>
              </pre>
              {!artifact?.parent && artifact?.sourceAnchor && (
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() =>
                    onRequest({
                      question: run!.question,
                      selection: artifact.sourceAnchor!,
                      regenerate: true,
                    })
                  }
                >
                  Generate a new walkthrough
                </button>
              )}
            </details>
          )}
        </>
      )}
      <form
        className="proof-question"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !question.trim()) return;
          onRequest({
            question: question.trim(),
            ...(run?.answer?.proof
              ? { parent: { runId: run.id, prerequisiteId: null } }
              : {}),
          });
        }}
      >
        <label htmlFor="proof-question">Explain a prerequisite or proof step</label>
        <textarea
          id="proof-question"
          rows={2}
          maxLength={8000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            if (!disabled && question.trim()) event.currentTarget.form?.requestSubmit();
          }}
          placeholder="For example: why does this use induction?"
        />
        <button
          className="text-button"
          type="submit"
          disabled={disabled || !question.trim()}
        >
          Build a step-by-step explanation <ArrowRight size={14} />
        </button>
      </form>
    </section>
  );
}
