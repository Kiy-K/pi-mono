# Current Pi Evaluation Loop Design

## Decision

Use a two-tier, stock-versus-candidate evaluation loop for minimal Pi harness
changes. Tier 1 establishes the changed mechanism on controlled diagnostics.
Tier 2 confirms that a surviving candidate on the pre-registered DeepSWE
development split has an end-to-end benefit. The decision policy is Pareto,
not strict no-overhead: a candidate may consume bounded additional runtime only
when it produces a demonstrated quality benefit.

## Current identity

The current fork source anchor is
`21f0bea88fdfbf5967497a4e8864eddaec11a310` (2026-08-19). It includes an
upstream merge and therefore is not itself a "stock" treatment. Every new
comparison must declare:

- `sourceAnchor`: the common commit from which both treatments are built;
- `stock`: a clean artifact at that anchor with no evaluated patch;
- `candidate`: the same artifact plus one declared minimal patchset;
- SHA-256 hashes for both build artifacts and their dependency lockfiles.

The old `581d75a89cea21e50d6a26df840352f94427f633` results remain historical
evidence only. They must not be pooled with a comparison based on the current
source anchor.

The current mandated evaluator is DeepSeek V4 Flash through ClinePass at
medium thinking. Its external provider extension/package version, configuration
hash, resolved model ID, and authentication mode must be recorded in every
manifest. The checked-out fork does not itself declare a ClinePass provider
dependency, so a reproducible run is blocked until that external provider
artifact is pinned and its headless invocation is smoke-tested. The historical
`openai-codex/gpt-5.6-luna` DeepSWE protocol is a separate experiment and must
not be substituted silently.

## Identical-treatment contract

For a matched trial, stock and candidate use the same task revision, task
fixture/container digest, evaluator and its version, model/provider route,
thinking level, prompt, tool permissions, timeout, retry policy, concurrency,
environment, and verifier command. The only permitted behavioral difference is
the candidate patch listed in the manifest.

Run matched trials in an interleaved, pre-recorded order such as
`stock, candidate, candidate, stock`. Do not change an input, model setting,
or task after observing a stock trajectory. A task result may not be credited
until its paired treatment is immutable.

## Run manifest and outcome taxonomy

Before execution, write a machine-readable manifest containing the identity
fields above plus the command lines, hostname/OS/container information, start
time, task revision, run order, and a unique run ID. Preserve raw session,
stderr, verifier, and telemetry artifacts under that run ID.

Each launched trial receives exactly one outcome:

| Outcome | Capability denominator | Meaning |
| --- | --- | --- |
| `solved` | included | Hidden or deterministic verifier accepted the patch. |
| `unsolved` | included | Agent completed a valid attempt but did not satisfy the verifier. |
| `timeout_harness` | included | Pi or its descendant processes exceeded the declared harness budget. |
| `timeout_task` | included | A valid task attempt exhausted its declared task budget. |
| `invalid_infra` | excluded | Evaluator, container, filesystem, or host failure prevented a valid attempt. |
| `invalid_provider` | excluded | Provider authentication, transport, or model-service failure prevented a valid attempt. |
| `cancelled_user` | excluded | The run was intentionally cancelled before a valid result existed. |

Invalid and cancelled trials are never evidence of capability, and never are
silently dropped: their counts, causes, cleanup result, and affected treatment
remain in the report. A changed invalid rate is a reliability signal. Do not
compare capability rates when a treatment's valid-run rate is more than five
percentage points below its paired treatment; repair the blocker and rerun the
affected pair.

## Two-tier workload coverage

### Tier 1: controlled diagnostics

`packages/evals/diagnostics/manifest.json` is the mechanism suite. Expand it
only with a task that has one stated, deterministic harness mechanism and an
external verifier. Maintain coverage for:

1. task/goal persistence and stopping;
2. tool availability, argument handling, edit correctness, and tool failures;
3. verification feedback and final-edit freshness;
4. context growth, compaction, and recovery;
5. concurrent tool ordering, stale workspace state, and file mutation order;
6. shell/PTY/sandbox isolation, timeouts, cleanup, and process exit;
7. telemetry/session artifact completeness;
8. provider/model configuration parity.

The current three diagnostics are a smoke set, not sufficient coverage for an
acceptance claim across all eight categories. A proposed runtime change needs a
targeted deterministic regression that fails against stock before it is
evaluated model-in-the-loop.

### Tier 2: DeepSWE confirmation

Use the pinned task protocol in `packages/evals/deepswe/protocol.json` and the
isolated rules in `packages/evals/docs/official-benchmark-protocol.md`. The
development list is for hypothesis selection; holdout tasks must not be
inspected, used to choose a design, or counted as a development success.

DeepSWE results confirm end-to-end behavior, not a mechanism by themselves.
Do not describe a partial subset result as an official DeepSWE score. The
previous cancelled metadata trial remains explicitly invalid and cannot be
converted into a stock/candidate observation.

## Sampling and escalation

The standard screen is five valid paired trials per treatment. Continue until
each treatment has five valid trials; an invalid or cancelled launch does not
consume a trial. Escalate the same frozen configuration to ten valid paired
trials per treatment only when the screen is promising or ambiguous:

- one or more solve-rate changes are observed but the direction is not stable;
- the result is near an acceptance bound;
- reliability, cost, or latency differs materially;
- the candidate has a Tier 1 signal and needs Tier 2 confirmation.

No result may be promoted merely because it is the best of several unrecorded
reruns. Report every launch and pre-register any rerun reason.

## Pareto acceptance gate

A candidate is accepted only when all applicable gates pass:

| Dimension | Requirement |
| --- | --- |
| Comparability | Identical-treatment contract and complete manifest. |
| Correctness | No lower Tier 1 solve rate; Tier 2 is non-inferior when run. |
| Benefit | At least one pre-registered mechanism metric improves, or the five-trial screen gains at least one valid solve. |
| Reliability | No new fatal failure class and no valid-run-rate drop greater than 5 percentage points. |
| Cost | With no solve gain, median total token/cost increase is at most 15%. A larger increase requires a pre-registered quality gain. |
| Latency | With no solve gain, median wall-clock increase is at most 20%. A larger increase requires a pre-registered quality gain. |
| Runtime weight | No always-on dependency, background service, or persistent state unless it remedies a demonstrated failure and passes Tier 2. |
| Uncertainty | A split, small, or confounded screen is `inconclusive`, never an approval. Escalate to ten valid trials. |

An approved change must identify the winning mechanism in its trajectories;
otherwise it is correlation, not evidence that the harness modification caused
the outcome. A rejected change is retained in `packages/evals/EXPERIMENTS.jsonl`
with its complete negative evidence.

## Delivery sequence

1. Make the existing runners emit the complete manifest and explicit outcome
   taxonomy.
2. Pin and smoke-test the ClinePass provider artifact and DeepSeek V4 Flash
   headless invocation; record any failure as `blocked`, not a benchmark score.
3. Add deterministic coverage for the missing Tier 1 categories before calling
   the diagnostic suite comprehensive.
4. Build current-anchor stock and candidate artifacts; prove their declared
   diff is the only treatment delta.
5. Run the diagnostic 5+5 screen. Surface and repair blockers rather than
   scoring invalid or cancelled trials.
6. Run DeepSWE only for a Tier 1 survivor, then apply the Pareto gate and
   update the priorities/experiment record with `accepted`, `rejected`,
   `inconclusive`, or `blocked`.
