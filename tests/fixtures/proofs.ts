import type { ProofBreakdown } from '../../src/proof.ts';

export const PROOF_FIXTURE: ProofBreakdown = {
  title: 'Associativity of natural-number addition',
  claim: 'For natural numbers, adding three terms is independent of grouping.',
  interpretation: 'The selected argument uses associativity of addition.',
  summary: 'Introduce the three numbers, then apply the associativity theorem.',
  assumptions: ['a, b and c are natural numbers.'],
  gaps: [],
  imports: [],
  statement: '∀ (a b c : Nat), (a + b) + c = a + (b + c)',
  steps: [
    {
      id: 'introduce',
      title: 'Choose the numbers',
      explanation: 'The claim is universal, so take arbitrary natural numbers.',
      tactic: 'intro a b c',
      evidenceIds: ['paper:p1:c1'],
      prerequisiteIds: [],
    },
    {
      id: 'associate',
      title: 'Apply associativity',
      explanation: 'Nat.add_assoc proves this equality for any three numbers.',
      tactic: 'exact Nat.add_assoc a b c',
      evidenceIds: ['paper:p1:c1'],
      prerequisiteIds: ['associativity'],
    },
  ],
  prerequisites: [
    {
      id: 'associativity',
      title: 'Associativity',
      kind: 'theorem',
      summary: 'Changing the grouping of an addition does not change its result.',
    },
  ],
};
