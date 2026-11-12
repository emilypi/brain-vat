import { z } from 'zod';
import type { Anchor } from './document.ts';

export const LEAN_VERSION = '4.35.0';
export const MATHLIB_VERSION = 'v4.35.0';
export const PROOF_THEOREM = 'brainVatProof';
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const evidenceIds = z.array(z.string().max(100)).max(20);

export const proofParentSchema = z.strictObject({
  runId: z.string().uuid(),
  prerequisiteId: identifier.nullable(),
});
export type ProofParent = z.infer<typeof proofParentSchema>;

/** Model proposals contain no verification status or purported measured goals. */
export const proofBreakdownSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  claim: z.string().trim().min(1).max(4000),
  interpretation: z.string().trim().min(1).max(4000),
  summary: z.string().trim().min(1).max(6000),
  assumptions: z.array(z.string().max(2000)).max(20),
  gaps: z.array(z.string().max(2000)).max(20),
  imports: z
    .array(
      z
        .string()
        .max(200)
        .regex(/^Mathlib(?:\.[A-Za-z0-9_]+)+$/),
    )
    .max(8),
  statement: z.string().trim().min(1).max(8000).nullable(),
  steps: z
    .array(
      z.strictObject({
        id: identifier,
        title: z.string().trim().min(1).max(160),
        explanation: z.string().trim().min(1).max(6000),
        tactic: z.string().trim().min(1).max(6000).nullable(),
        evidenceIds,
        prerequisiteIds: z.array(identifier).max(12),
      }),
    )
    .min(1)
    .max(24),
  prerequisites: z
    .array(
      z.strictObject({
        id: identifier,
        title: z.string().trim().min(1).max(160),
        summary: z.string().trim().min(1).max(2000),
        kind: z.enum(['definition', 'lemma', 'theorem', 'background']),
      }),
    )
    .max(20),
});
export type ProofBreakdown = z.infer<typeof proofBreakdownSchema>;

/** Attached by the server, never accepted from generated model output. */
export interface ProofArtifact {
  sourceHash: string;
  sourceAnchor: Anchor | null;
  parent: ProofParent | null;
}

export interface ProofContext {
  parentRunId: string;
  title: string;
  claim: string;
  interpretation: string;
  summary: string;
  assumptions: string[];
  steps: { title: string; explanation: string }[];
  prerequisite: ProofBreakdown['prerequisites'][number] | null;
  sourceAnchor: Anchor | null;
}

export interface ProofStepLocation {
  stepId: string;
  /** Zero-based source lines. */
  startLine: number;
  endLine: number;
}

export interface LeanSource {
  code: string;
  challenge: string;
  steps: ProofStepLocation[];
}

/** Fixed theorem and pinned module imports. Content remains untrusted Lean input. */
export function renderLeanProof(proof: ProofBreakdown): LeanSource | null {
  if (!proof.statement) return null;
  const imports = new Set([
    'Mathlib.Tactic',
    'Mathlib.Algebra.Module.Basic',
    ...proof.imports,
  ]);
  const header = [
    ...[...imports].map((name) => 'import ' + name),
    '',
    'set_option maxHeartbeats 200000',
    'set_option maxRecDepth 1000',
    '',
    'theorem ' + PROOF_THEOREM + ' :',
    ...proof.statement.split('\n').map((line) => '  ' + line),
    ':= by',
  ];
  const lines = [...header];
  const steps = proof.steps.map((step) => {
    const startLine = lines.length;
    lines.push(...(step.tactic ?? 'sorry').split('\n').map((line) => '  ' + line));
    return { stepId: step.id, startLine, endLine: lines.length - 1 };
  });
  return {
    code: lines.join('\n') + '\n',
    challenge: [...header, '  sorry', ''].join('\n'),
    steps,
  };
}

export function proofReferenceError(
  proof: ProofBreakdown,
  knownEvidence: ReadonlySet<string>,
): string | null {
  const ids = proof.steps.map((step) => step.id);
  const prerequisites = new Set(proof.prerequisites.map((item) => item.id));
  if (
    new Set(ids).size !== ids.length ||
    prerequisites.size !== proof.prerequisites.length
  )
    return 'Proof steps and prerequisites need unique identifiers.';
  if (
    proof.steps.some(
      (step) =>
        step.evidenceIds.some((id) => !knownEvidence.has(id)) ||
        step.prerequisiteIds.some((id) => !prerequisites.has(id)),
    )
  )
    return 'A proof step refers to missing evidence or a prerequisite.';
  if (
    JSON.stringify(proof).length > 120_000 ||
    (renderLeanProof(proof)?.code.length ?? 0) > 50_000
  )
    return 'The proof walkthrough is too large.';
  return null;
}

export interface LeanStatus {
  available: boolean;
  leanVersion: string;
  mathlibVersion: string;
  message: string;
}

export interface ProofDiagnostic {
  severity: 'error' | 'warning' | 'information';
  message: string;
  line: number | null;
  column: number | null;
}

export interface ProofStepGoals {
  stepId: string;
  before: string[];
  after: string[];
}

export interface ProofCheckResult {
  status: 'checked' | 'incomplete' | 'failed' | 'unavailable' | 'cancelled';
  message: string;
  diagnostics: ProofDiagnostic[];
  steps: ProofStepGoals[];
  axioms: string[];
}

export interface ProofCheck extends Omit<ProofCheckResult, 'status'> {
  id: string;
  runId: string;
  sourceHash: string;
  leanVersion: string;
  mathlibVersion: string;
  status: ProofCheckResult['status'] | 'running';
  createdAt: string;
  finishedAt: string | null;
}

export interface LeanChecker {
  status(): Promise<LeanStatus>;
  check(proof: ProofBreakdown, signal: AbortSignal): Promise<ProofCheckResult>;
}
