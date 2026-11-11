import { describe, expect, it } from 'vitest';
import {
  proofBreakdownSchema,
  proofReferenceError,
  renderLeanProof,
} from '../../src/proof.ts';
import { PROOF_FIXTURE } from '../fixtures/proofs';

describe('proof proposal boundaries', () => {
  it('preserves code indentation and source positions for actual goal inspection', () => {
    const proof = structuredClone(PROOF_FIXTURE);
    proof.steps[1]!.tactic = 'have h := Nat.add_assoc a b c\nexact h';
    const source = renderLeanProof(proof)!;
    const lines = source.code.split('\n');
    expect(lines[source.steps[0]!.startLine]).toBe('  intro a b c');
    expect(lines[source.steps[1]!.startLine]).toBe('  have h := Nat.add_assoc a b c');
    expect(lines[source.steps[1]!.endLine]).toBe('  exact h');
    expect(source.challenge).toContain(proof.statement);
    expect(source.challenge).not.toContain('exact h');
    expect(source.challenge).toMatch(/:= by\n {2}sorry\n$/);
  });

  it('retains missing formalizations and admits missing tactics explicitly', () => {
    expect(renderLeanProof({ ...PROOF_FIXTURE, statement: null })).toBeNull();
    const proof = structuredClone(PROOF_FIXTURE);
    proof.steps[1]!.tactic = null;
    expect(renderLeanProof(proof)?.code).toMatch(/intro a b c\n {2}sorry\n$/);
  });

  it('rejects verification claims in a model proposal', () => {
    expect(
      proofBreakdownSchema.safeParse({ ...PROOF_FIXTURE, status: 'checked' }).success,
    ).toBe(false);
    const step = { ...PROOF_FIXTURE.steps[0], actualGoals: [] };
    expect(
      proofBreakdownSchema.safeParse({ ...PROOF_FIXTURE, steps: [step] }).success,
    ).toBe(false);
  });

  it.each(['Mathlib', 'Proof', '../Mathlib', 'Mathlib.Tactic\n#eval 1'])(
    'rejects an unrestricted import %s',
    (name) => {
      expect(
        proofBreakdownSchema.safeParse({ ...PROOF_FIXTURE, imports: [name] }).success,
      ).toBe(false);
    },
  );

  it('includes additional pinned modules in both challenge and solution', () => {
    const source = renderLeanProof({
      ...PROOF_FIXTURE,
      imports: ['Mathlib.Topology.Basic', 'Mathlib.Tactic'],
    })!;
    expect(source.code).toContain('import Mathlib.Topology.Basic\n');
    expect(source.challenge).toContain('import Mathlib.Topology.Basic\n');
    expect(source.code.match(/import Mathlib.Tactic/g)).toHaveLength(1);
  });

  it.each(['evidence', 'prerequisite', 'duplicate'])(
    'rejects invalid %s references',
    (kind) => {
      const proof = structuredClone(PROOF_FIXTURE);
      if (kind === 'evidence') proof.steps[0]!.evidenceIds = ['made-up'];
      if (kind === 'prerequisite') proof.steps[0]!.prerequisiteIds = ['missing'];
      if (kind === 'duplicate') proof.steps[1]!.id = proof.steps[0]!.id;
      expect(proofReferenceError(proof, new Set(['paper:p1:c1']))).not.toBeNull();
    },
  );
});
