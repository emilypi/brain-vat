# Reading proofs with Lean

Select a passage with ordinary PDF selection or the precision **Text** tool.
Use **Area** for an equation, figure, or awkward mathematical layout. Choose
**Break down proof** to open the proof workspace beside the PDF.

The walkthrough begins with its interpretation of the selected passage, a claim,
a summary, assumptions and any known gaps. Inspect the interpretation when the
selection is an image: notation and omitted context can change a theorem's meaning.

Move through the steps using **Previous** and **Next**. Each step explains its
purpose, links to its evidence, and offers the proposed Lean tactic. Lean detail
shows actual goals from the checker when available. A closed goal for one tactic
does not mean every branch of the proof is complete.

Expand a listed prerequisite to get another summary and stepwise walkthrough.
You can also ask about background knowledge in your own words. Child explanations
retain their parent proof and original source passage, even after the conversation
grows. Use the parent navigation to return to the argument. Shared-room proofs and
check results persist; solo walkthroughs last for the current reading session.

## Reading verification status

- **Proposed**: generated explanation and Lean code, awaiting a check.
- **Checking**: the isolated Lean worker is inspecting the proof.
- **Checked**: the displayed formal statement passes independent Lean kernel
  replay against the challenge statement using only permitted standard axioms.
- **Incomplete**: missing goals, admitted steps, or dependencies prevent completion.
- **Failed**: the proposed code or verification did not succeed; inspect diagnostics.
- **Unavailable**: the pinned runtime or safe execution environment is unavailable.
- **Cancelled**: checking stopped without establishing a result.

Completed check results are immutable. Repeated delivery returns the same result;
an unavailable check can be retried after setup or capacity becomes available.
Create a new walkthrough to revise an unsuccessful formalization.

The check applies to the formal statement displayed in the workspace. It does not
establish that the interpretation perfectly matches the paper. Added assumptions
and formalization gaps remain visible even when the formal implication checks.
The model cannot assign verification status, observed goals, or source hashes.

For example, the sample paper's Lemma B.5 on page 31 reduces to the algebraic fact
that `f = a • f + g` implies `(1 - a) • f = g` in a module over a ring. Checking this
implication validates the cancellation step. It does not construct the paper's
convolution operators or prove existence and uniqueness of its recurrence.

## Runtime and trust

The native checker currently runs on macOS with `sandbox-exec` and the Xcode command
line tools. Install [elan](https://github.com/leanprover/elan), then run:

```sh
elan toolchain install leanprover/lean4:v4.35.0
pnpm setup:lean
pnpm test:lean
```

Restart the server after setup. `/api/health` reports Lean readiness. Setup downloads
the pinned Mathlib cache (about 7 GB locally, in addition to the Lean toolchain).
The cache and machine-specific paths stay in ignored `lean/.lake/` files.
On other platforms, explanations remain available and Lean checks are unavailable.

Lean and Mathlib are pinned at version 4.35.0, with a committed dependency lock.
Proof checks do not download libraries. The worker accepts only stored, bounded
proof proposals and renders the theorem and project configuration itself. It imports
basic module algebra and tactics, plus at most eight specific Mathlib modules named
by the proposal. It does not load all of Mathlib for every check.

Compilation, goal inspection, export and comparison run with restricted access.
Challenge and solution exports are produced independently; untrusted compilation
cannot alter the files used by the final comparison. Their standard axioms and
primitive definitions are compared against a trusted `Init` export before statement
comparison and independent kernel replay. Time, output and process
limits prevent a checking job from occupying the service indefinitely. A missing
sandbox never triggers an unrestricted fallback.

The server runs at most two checks concurrently, with a 90-second worker deadline
and a bounded queue. The native launcher applies hard CPU, stack, file and descriptor
limits. Compilation and goal workers use a 4 GiB Lean allocation budget; inspection
uses 1 GiB. These are not OS-enforced resident-memory limits. Every stage denies
network access and subprocess creation. Use a dedicated account and host-level
limits before broader multi-tenant use.

This follows Lean's distinction between a proof that elaborates and a proof that
has been independently replayed with an axiom policy. See the official
[proof validation guide](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)
and [comparator documentation](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/).
