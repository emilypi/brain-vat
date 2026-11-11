import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LEAN_VERSION, MATHLIB_VERSION, renderLeanProof } from '../src/proof.ts';
import type {
  LeanChecker,
  LeanStatus,
  ProofBreakdown,
  ProofCheck,
  ProofCheckResult,
  ProofContext,
  ProofParent,
} from '../src/proof.ts';
import type {
  AiRun,
  GeneratedAnswer,
  ProviderInput,
} from '../src/workspace-contract.ts';

const resultSchema = z.object({
  status: z.enum(['checked', 'incomplete', 'failed', 'unavailable', 'cancelled']),
  message: z.string().max(4000),
  diagnostics: z
    .array(
      z.object({
        severity: z.enum(['error', 'warning', 'information']),
        message: z.string().max(20_000),
        line: z.number().int().nonnegative().nullable(),
        column: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(100),
  steps: z
    .array(
      z.object({
        stepId: z.string().max(40),
        before: z.array(z.string().max(20_000)).max(32),
        after: z.array(z.string().max(20_000)).max(32),
      }),
    )
    .max(24),
  axioms: z.array(z.string().max(500)).max(100),
});

export const unavailableLeanChecker: LeanChecker = {
  status: async () => ({
    available: false,
    leanVersion: LEAN_VERSION,
    mathlibVersion: MATHLIB_VERSION,
    message: 'Lean verification is not configured on this server.',
  }),
  check: async () => proofCheckOutcome('unavailable', 'Lean is not configured.'),
};

/** Hash the exact program, challenge, step mapping and pinned libraries. */
export function proofSourceHash(proof: ProofBreakdown): string {
  return createHash('sha256')
    .update(JSON.stringify([LEAN_VERSION, MATHLIB_VERSION, renderLeanProof(proof)]))
    .digest('hex');
}

/** Caller resolves the parent inside its authorized room or solo session. */
export function proofContextFor(
  parent: AiRun,
  reference: ProofParent,
): ProofContext | null {
  const proof = parent.answer?.proof;
  if (parent.kind !== 'proof' || parent.status !== 'completed' || !proof) return null;
  const prerequisite =
    reference.prerequisiteId === null
      ? null
      : proof.prerequisites.find((item) => item.id === reference.prerequisiteId);
  if (prerequisite === undefined) return null;
  return {
    parentRunId: parent.id,
    title: proof.title,
    claim: proof.claim,
    interpretation: proof.interpretation,
    summary: proof.summary,
    assumptions: proof.assumptions,
    steps: proof.steps.map(({ title, explanation }) => ({ title, explanation })),
    prerequisite,
    sourceAnchor: parent.answer?.proofArtifact?.sourceAnchor ?? null,
  };
}

/** Only validated model proposals enter here; provenance is always server-owned. */
export function attachProofArtifact(
  answer: GeneratedAnswer,
  input: ProviderInput,
): GeneratedAnswer {
  if (input.kind !== 'proof') {
    if (answer.proof) throw new Error('Unexpected proof in a non-proof answer.');
    return answer;
  }
  if (!answer.proof) throw new Error('The provider omitted the requested proof.');
  const context = input.proofContext;
  return {
    ...answer,
    proofArtifact: {
      sourceHash: proofSourceHash(answer.proof),
      sourceAnchor: context ? context.sourceAnchor : input.selection,
      parent: context
        ? {
            runId: context.parentRunId,
            prerequisiteId: context.prerequisite?.id ?? null,
          }
        : null,
    },
  };
}

export function proofCheckOutcome(
  status: ProofCheckResult['status'],
  message: string,
): ProofCheckResult {
  return { status, message, diagnostics: [], steps: [], axioms: [] };
}

export function newProofCheck(runId: string, sourceHash: string): ProofCheck {
  return {
    ...proofCheckOutcome('unavailable', 'Queued for Lean verification.'),
    id: randomUUID(),
    runId,
    sourceHash,
    leanVersion: LEAN_VERSION,
    mathlibVersion: MATHLIB_VERSION,
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
}

interface ProofJob {
  proof: ProofBreakdown;
  controller: AbortController;
  finish: (result: ProofCheckResult) => void;
  started: boolean;
}

/** One bounded execution queue shared by solo and authenticated reading rooms. */
export class ProofExecutor {
  private readonly jobs = new Map<string, ProofJob>();
  private active = 0;
  private startedToday = 0;
  private day = new Date().toISOString().slice(0, 10);
  private closed = false;

  constructor(readonly checker: LeanChecker) {}

  async status(): Promise<LeanStatus> {
    try {
      return await this.checker.status();
    } catch {
      return unavailableLeanChecker.status();
    }
  }

  schedule(
    runId: string,
    proof: ProofBreakdown,
    finish: (result: ProofCheckResult) => void,
  ): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.startedToday = 0;
    }
    if (
      this.closed ||
      this.jobs.has(runId) ||
      this.jobs.size >= 16 ||
      this.startedToday >= 500
    )
      return false;
    this.startedToday += 1;
    this.jobs.set(runId, {
      proof,
      finish,
      controller: new AbortController(),
      started: false,
    });
    this.pump();
    return true;
  }

  cancel(runId: string, message = 'Lean verification was cancelled.'): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    this.publish(runId, job, proofCheckOutcome('cancelled', message));
    job.controller.abort();
  }

  close(): void {
    this.closed = true;
    for (const id of this.jobs.keys())
      this.cancel(id, 'Server stopped before verification finished; not checked.');
  }

  private publish(runId: string, job: ProofJob, result: ProofCheckResult): void {
    if (this.jobs.get(runId) !== job) return;
    this.jobs.delete(runId);
    // A failed database write leaves a durable running record for startup recovery.
    try {
      job.finish(result);
    } catch {
      /* Never issue the Lean job again. */
    }
  }

  private pump(): void {
    if (this.closed) return;
    for (const [runId, job] of this.jobs) {
      if (this.active >= 2) break;
      if (job.started) continue;
      job.started = true;
      this.active += 1;
      void this.execute(runId, job);
    }
  }

  private async execute(runId: string, job: ProofJob): Promise<void> {
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort(), 120_000);
    timer.unref();
    try {
      const cancelled = new Promise<ProofCheckResult>((resolve) => {
        signal.addEventListener(
          'abort',
          () =>
            resolve(
              proofCheckOutcome(
                'cancelled',
                'Verification stopped before a verdict; not checked.',
              ),
            ),
          { once: true },
        );
      });
      const result = await Promise.race([
        this.checker.check(job.proof, signal),
        cancelled,
      ]);
      const bounded = resultSchema.parse(result);
      const knownSteps = new Set(job.proof.steps.map((step) => step.id));
      if (
        Buffer.byteLength(JSON.stringify(bounded)) > 200_000 ||
        new Set(bounded.steps.map((step) => step.stepId)).size !==
          bounded.steps.length ||
        bounded.steps.some((step) => !knownSteps.has(step.stepId))
      )
        throw new Error('Invalid Lean result.');
      this.publish(runId, job, bounded);
    } catch {
      this.publish(
        runId,
        job,
        proofCheckOutcome(
          'failed',
          'Lean verification failed before a verdict; not checked.',
        ),
      );
    } finally {
      clearTimeout(timer);
      this.active -= 1;
      this.pump();
    }
  }
}
