import { z } from 'zod';
import type { AiRun } from '../src/workspace-contract.ts';
import type { SavedContextSummary } from '../src/saved-context.ts';
import { LEAN_VERSION, MATHLIB_VERSION } from '../src/proof.ts';
import type { ProofCheck, RememberedProof } from '../src/proof.ts';
import { proofCheckOutcome, proofSourceHash } from './proofs.ts';

export const MAX_SAVED_RUNS = 500;
export const MAX_CONTEXT_BYTES = 16_000_000;
export const MAX_CONTEXTS = 100;
export const MAX_CONTEXT_TOTAL_BYTES = 128_000_000;

export const soloPaperSchema = z
  .strictObject({
    documentId: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(500),
    pages: z
      .array(
        z.strictObject({
          pageIndex: z.number().int().min(0).max(299),
          text: z.string().max(2_000_000),
        }),
      )
      .min(1)
      .max(300),
  })
  .refine(
    (value) =>
      value.pages.every((page, index) => page.pageIndex === index) &&
      value.pages.reduce((sum, page) => sum + page.text.length, 0) <= 2_000_000,
  );
export type SoloPaper = z.infer<typeof soloPaperSchema>;

/** Only the server creates this payload; no API accepts imported state. */
export interface StoredSoloContext {
  paper: SoloPaper;
  runs: { run: AiRun; digest: string }[];
  checks: ProofCheck[];
}

export interface StoredSoloRecord {
  summary: SavedContextSummary;
  state: StoredSoloContext;
}

/** Reserve bounded results before dispatch so completion cannot fill the store. */
export function reservedContextBytes(state: StoredSoloContext, body: string): number {
  const running = state.runs.filter(({ run }) => run.status === 'running').length;
  const checking = state.checks.filter((check) => check.status === 'running').length;
  return Buffer.byteLength(body) + running * 4_000_000 + checking * 900_000;
}

/** A restart never resumes paid work or claims an unfinished check succeeded. */
export function interruptStoredContext(state: StoredSoloContext): boolean {
  let changed = false;
  for (const entry of state.runs) {
    if (entry.run.status !== 'running') continue;
    changed = true;
    entry.run = {
      ...entry.run,
      status: 'uncertain',
      error: 'Service stopped before the provider outcome was recorded; not retried.',
    };
  }
  state.checks = state.checks.map((check) => {
    if (check.status !== 'running') return check;
    changed = true;
    return {
      ...check,
      ...proofCheckOutcome(
        'failed',
        'Verification stopped before completion; the outcome is unconfirmed.',
      ),
      finishedAt: new Date().toISOString(),
    };
  });
  return changed;
}

/** Keep selected-page results first, then recent history, within a fixed budget. */
export function rememberedProofs(
  runs: AiRun[],
  checks: Map<string, ProofCheck>,
  pageIndex: number | undefined,
): RememberedProof[] {
  const ordered = [...runs].reverse().sort((a, b) => {
    const onPage = (run: AiRun): number =>
      pageIndex !== undefined &&
      run.answer?.proofArtifact?.sourceAnchor?.pageIndex === pageIndex
        ? 1
        : 0;
    return onPage(b) - onPage(a);
  });
  const remembered: RememberedProof[] = [];
  let remaining = 24_000;
  for (const run of ordered) {
    const proof = run.answer?.proof;
    const artifact = run.answer?.proofArtifact;
    if (run.status !== 'completed' || !proof || !artifact) continue;
    const candidate = checks.get(run.id);
    const check = candidate?.sourceHash === artifact.sourceHash ? candidate : null;
    const entry: RememberedProof = {
      runId: run.id,
      title: proof.title,
      claim: proof.claim,
      summary: proof.summary,
      assumptions: proof.assumptions,
      gaps: proof.gaps,
      statement: proof.statement,
      sourceAnchor: artifact.sourceAnchor,
      verification: {
        status: check?.status ?? 'not-checked',
        sourceHash: artifact.sourceHash,
        leanVersion: check?.leanVersion ?? null,
        mathlibVersion: check?.mathlibVersion ?? null,
        matchesCurrentRuntime:
          check?.leanVersion === LEAN_VERSION &&
          check?.mathlibVersion === MATHLIB_VERSION &&
          artifact.sourceHash === proofSourceHash(proof),
      },
    };
    const size = JSON.stringify(entry).length;
    // Never truncate away hypotheses or gaps to make a result appear stronger.
    if (size > remaining) continue;
    remaining -= size;
    remembered.push(entry);
    if (remembered.length >= 8) break;
  }
  return remembered;
}
