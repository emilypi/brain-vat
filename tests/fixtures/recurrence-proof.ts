import type { ProofBreakdown } from '../../src/proof.ts';

/** Algebraic step in sample paper p31, Lemma B.5; Rec itself is not formalized. */
export const RECURRENCE_PROOF: ProofBreakdown = {
  title: 'The inverse-recurrence algebraic step',
  claim: 'A fixed point f = a • f + g satisfies (1 - a) • f = g.',
  interpretation:
    'In Lemma B.5, kernels act on signals. Represent kernels by a ring R, ' +
    'signals by an R-module M, convolution by scalar action, and Rec(A,G) by f.',
  summary:
    'Expand the action of 1 - a, simplify the identity action, then rearrange ' +
    'the given recurrence equation using additive cancellation.',
  assumptions: [
    'R is a ring and M is a module over R.',
    'f = a • f + g is the defining fixed-point equation being used.',
  ],
  imports: [],
  gaps: [
    'This checks the algebraic implication. The paper’s convolution model and ' +
      'existence/uniqueness of Rec are not constructed in this formalization.',
  ],
  statement:
    '∀ (R M : Type) [Ring R] [AddCommGroup M] [Module R M] ' +
    '(a : R) (f g : M), f = a • f + g → (1 - a) • f = g',
  steps: [
    {
      id: 'context',
      title: 'Introduce the fixed-point equation',
      explanation: 'Name the algebraic objects and the hypothesis describing f.',
      tactic: 'intro R M _ _ _ a f g h',
      evidenceIds: ['paper:p31:c1'],
      prerequisiteIds: ['module'],
    },
    {
      id: 'expand',
      title: 'Expand the difference of actions',
      explanation: 'Use subtraction distributivity and the identity scalar action.',
      tactic: 'rw [sub_smul, one_smul]',
      evidenceIds: ['paper:p31:c1'],
      prerequisiteIds: ['module'],
    },
    {
      id: 'cancel',
      title: 'Rearrange and cancel',
      explanation:
        'The remaining equality is f - a • f = g. It is equivalent to ' +
        'f = g + a • f, which is the hypothesis with its summands exchanged.',
      tactic: 'exact sub_eq_iff_eq_add.mpr (by simpa [add_comm] using h)',
      evidenceIds: ['paper:p31:c1'],
      prerequisiteIds: ['cancellation'],
    },
  ],
  prerequisites: [
    {
      id: 'module',
      kind: 'definition',
      title: 'A module and its scalar action',
      summary:
        'A ring acts on an additive commutative group, distributing over sums ' +
        'and respecting multiplication and the identity.',
    },
    {
      id: 'cancellation',
      kind: 'lemma',
      title: 'Rearranging subtraction',
      summary: 'In an additive group, x - y = z exactly when x = z + y.',
    },
  ],
};
