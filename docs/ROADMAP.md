# Brain Vat workpile

## Current delivery

- Astra-backed conversations grounded in paper passages and selected regions.
- Source links and definition expansion with explicit evidence origins.
- Browser accounts, durable storage, backups, and web/extension synchronization.
- Optional enhanced reading mode with source navigation.
- Browser invite links, shared annotations and AI conversations, collaborative
  CRDT notes, and presence.
- Broader PDF checks, accessibility, failure handling, usage limits, and a
  distributable extension.

## Next: Lean-assisted proof breakdowns

After the current delivery, add an optional proof workspace that connects a
paper's claims and proof passages to a Lean 4 development:

- Break proofs into named lemmas, dependencies, assumptions, and tactic steps.
- Link each step back to the paper and explain the purpose of the tactic.
- Distinguish informal explanation, proposed formalization, and kernel-checked
  results. Show unresolved goals, missing hypotheses, and admitted steps plainly.
- Pin Lean and mathlib versions and retain reproducible checking output.
- Run untrusted proof projects in an isolated worker with resource limits.
- Share proof discussions and checked artifacts within the reading workspace.

Acceptance requires an end-to-end example from a paper, including a successful
check and a deliberately incomplete proof that stays visibly unverified.
