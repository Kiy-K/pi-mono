# Completion-Evidence Gate — Pre-registered Intervention Spec

## Mechanistic Hypothesis

A completion-evidence gate reduces premature-abort failures by preventing
termination before substantive task execution.

## What the gate is

A harness-level mechanism that inspects observable execution evidence after
the agent's first run (Phase 1) and, if evidence of substantive work is
absent, permits exactly one generic continuation cycle before normal
stopping/verification behavior resumes.

## What the gate is NOT

- Not a prompt change. The continuation re-invokes the original prompt in the
  same workspace. No task-specific hints.
- Not verifier-aware. The gate does not run the verifier or read the spec.
- Not task-specific. The same threshold applies to every task identically.

## Gate trigger criteria

The gate fires when ALL of the following are true after Phase 1:

1. `toolCalls < 3` — the agent made fewer than 3 tool invocations total
   (reads, writes, edits, bash — everything counted equally).
2. `finalStopReason === "stop"` — the agent chose to stop (not timeout, not
   error).
3. `!timedOut` — Phase 1 did not hit the timeout.

Rationale: fewer than 3 tool calls means the agent barely interacted with the
workspace. Combined with a deliberate stop, this is strong evidence of
premature abort — the model decided it was done before doing meaningful work.

## Continuation behavior

When the gate fires:

1. The harness re-invokes pi with the **same prompt** in the **same
   workspace** (which may contain partial work from Phase 1).
2. The continuation runs with identical config (model, thinking, extensions).
3. Telemetry from the continuation is merged into the Phase 1 telemetry.
4. The continuation is Phase 1.5 — it sits between the generator and any
   post-generation phases (fresh-context verify, repair).

When the gate does NOT fire: normal flow continues unchanged.

## Recorded metrics

Every run records these fields (null/0 when gate does not fire):

| Field | Type | Description |
|-------|------|-------------|
| `gateAttemptedStop` | bool | Did Phase 1 trigger the gate? |
| `gatePhase1ToolCalls` | int | Tool calls in Phase 1 (before gate) |
| `gateContinuationRan` | bool | Did the continuation phase execute? |
| `gateContinuationToolCalls` | int | Tool calls in continuation phase |
| `gateContinuationResumed` | bool | Did continuation make any tool calls? |
| `gateOverheadTokens` | int | Additional tokens from continuation |
| `gateOverheadMs` | float | Additional time from continuation (ms) |

### False-positive detection

False positive = gate activated AND final solve is true. With < 3 tool calls,
this is extremely unlikely (agent needs at least 1 file write). Recorded for
audit but not prevented.

## A/B protocol

1. **Stock (control)**: no gate. Standard harness. Already baselined.
2. **Gate (treatment)**: gate enabled. Same model, same tasks, same config.
3. **Primary task**: config-migrate (70% baseline, 30% failure rate).
4. **Transfer task**: event-store (60% baseline, 40% failure rate).
5. **Regression task**: data-pipeline (80% baseline, 20% failure rate).

## Prediction

If the hypothesis is correct:
- Gate activations > 0 on config-migrate (some premature aborts detected)
- Continuation resumes substantive work (gateContinuationResumed = true)
- Solve rate improves on config-migrate (fewer premature aborts → more solves)
- Pattern replicates on event-store (transfer)
- No regression on data-pipeline (safety)

If the hypothesis is wrong:
- Gate activations = 0 (no premature aborts detected — threshold too tight)
- OR gate activations > 0 but continuation doesn't help (model committed to abort)
- OR solve rate unchanged (premature aborts aren't the binding constraint)

## Cost budget

Worst case: every rep triggers continuation → 2× tokens per rep. With 10 reps
and ~50k median tokens, worst-case overhead is ~500k tokens (~$0.025 at
DeepSeek V4 Flash pricing). Acceptable.
