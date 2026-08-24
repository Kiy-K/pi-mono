# Spec-Verification Prompt-Append — Pre-registered Intervention Spec

Status: preregistered, NOT yet tested (evaluator unavailable since 2026-08-22).
Implemented via the existing `--prompt-append` slot; no new code path.

## Evidence base (measured, deterministic)

1. The cart-promotions bundled public suite catches only 4 of 18 validated
   SPEC-violating mutants (`test/verification-signal.test.ts`, pinned
   2026-08-24). "Ran the bundled tests, saw green" is not evidence of external
   correctness on this task.
2. SPEC.md states the uncovered error cases are normative "even where
   `test_promotions.py` does not check them" — the agent is told and has the
   oracle in-workspace.
3. Historical stock failure (EXPERIMENTS.jsonl
   failed-verification-guideline-verdict-2026-08-14): the agent retained 5
   regressions and masked a typecheck while seeing green in-loop.
4. Negative prior result (completion-guard-signals-negative-evidence-2026-08-16):
   a BARE continuation ("keep going") on a no-test-command proxy was
   net-negative. This intervention differs: it directs a concrete verification
   action (re-derive checks from SPEC), it is not a bare re-invoke.

## Mechanism

Prompt-append on the improved arm only (arms otherwise mechanically
identical). Delivered via the existing `--prompt-append` slot, which appends
to the PHASE-1 PROMPT: the agent sees the directive from the first turn, not
at a stop boundary (the harness has no stop-boundary injection point; the
completion-evidence gate's bare re-invoke is the only post-stop mechanism and
measured net-negative in its generic form, completion-guard-signals-negative-
evidence-2026-08-16). Consequence: the directive may move verification
behavior THROUGHOUT the run (earlier SPEC reads, self-authored checks while
implementing), which the mediators below measure directly. Exact appended
text:

> After your current work appears complete: re-read SPEC.md and check every
> normative rule against your implementation — especially error cases the
> bundled tests do not check. Fix any mismatch, then run the available tests
> again.

Not oracle leakage: SPEC.md is in the workspace; the external verifier is
never referenced. Transfers to DeepSWE, where task specs exist but hidden
tests do not.

## Metrics (per rep, from completionSignature telemetry)

All mediators are LOWER-BOUND proxies, not complete measures:

- `specReads` counts only `read` tool calls naming SPEC.md; SPEC access via
  grep/bash (`grep SPEC.md`, `cat SPEC.md`) is invisible to it.
- `selfTestCommands` counts only explicit non-bundled `test_*.py` filenames
  in commands; self-derived checks under other names (check_spec.py, inline
  `python -c` assertions) are invisible to it.
- `bundledOnlyAfterLastMutation` / `unverifiedFinalMutation` are exact
  ordering facts over recorded tool events, not proxies. Terminology: they
  are candidate signals, NOT the failure class itself. A false green is the
  derived conjunction `bundledOnlyAfterLastMutation && verifier valid &&
  !verifier.passed`, computed at analysis level; the signature fields stay
  verifier-agnostic.

Primary: solve rate (external verifier, as always). The mechanism claims to
move the proxy mediators upward; if solve rate moves without them moving,
the result may still be real (unmeasured channels) but is unattributable to
the claimed mechanism — record as such.

## A/B protocol

5 stock + 5 treatment on cart-promotions (development split); identical model,
thinking, extensions, timeout. Escalate to 10+10 if promising or ambiguous.
log-rotate (holdout) stays untouched until a development gain is shown.

## Predictions

If correct: specReads > 0 in most treated reps (stock baseline unknown —
measure it), selfTestCommands increases, external-verifier failures among
bundled-only reps decrease, token overhead bounded (one extra verification
sweep, roughly one phase-1 continuation's worth).
If wrong: no mediator movement (prompt ignored) or solve rate unchanged —
reject and record.

## Rejection criteria

- Any material token/wall-time regression without solve-rate gain.
- Mediators move but solve rate does not (verification theater).
- Stock baseline already reads SPEC + self-tests on most reps (no headroom).
