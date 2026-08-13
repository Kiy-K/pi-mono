# Official benchmark protocol for Stock vs Improved Pi

Research date: 2026-08-13. Primary sources only.

## Recommendation

Use **DeepSWE v1.1** as the primary recognized benchmark. Use **Terminal-Bench
2.1** only as secondary corroboration.

DeepSWE is the less contamination-prone choice because its tasks were authored
from scratch, its reference solutions were never merged upstream, task images
contain only the base commit with future history removed, agent task-network
access is disabled, and v1.1 applies only the agent's committed patch in a fresh
verifier container. The official paper also reports that timeouts and context
failures count as failures, while provider, verifier, and network errors are
excluded. [[DeepSWE paper](https://arxiv.org/abs/2607.07946)]
[[v1.1 release](https://deepswe.datacurve.ai/blog/deepswe-v1-1)]

Terminal-Bench 2.1 is public, permits internet access in all current tasks, and
uses shared agent/verifier containers. Its official process mitigates gaming
with delayed test upload, trajectory review, and disqualification, but it is not
a clean holdout. [[TB 2.1 release](https://www.tbench.ai/news/terminal-bench-2-1)]
[[submission policy](https://github.com/harbor-framework/terminal-bench-2-1/blob/7131e4375048a0e408a8fb404b5f499d726b695b/leaderboard/SUBMIT.md)]

## DeepSWE v1.1 protocol

### Frozen identity and scope

- Repository commit:
  [`435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`](https://github.com/datacurve-ai/deep-swe/commit/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9).
- Dataset name: `datacurve/deep-swe-1-1`; 113 tasks across 91 repositories and
  TypeScript, Go, Python, JavaScript, and Rust.
- Evaluator: `datacurve-pier==0.3.1`, tag/commit
  [`df89f994623a0a6a57229103b6fe910766693c30`](https://github.com/datacurve-ai/pier/tree/df89f994623a0a6a57229103b6fe910766693c30).
- There is no official development/test split. Official results cover the full
  113-task corpus; deterministic seeded subsets are supported for local runs.
- This fork excludes `abs-module-cache-flags` and
  `optique-conditional-option-dependencies` because hidden verifier material was
  exposed during protocol work. Local results therefore cover at most 111 tasks
  and must not be reported as an official full-corpus score.
- License: Apache-2.0 for Datacurve's task specifications, verifiers, and
  curation. Upstream repository code retains its own license; the official
  provenance file lists each one.

Sources: [[dataset README](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/README.md)]
[[dataset manifest](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/tasks/dataset.toml)]
[[provenance](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/PROVENANCE.md)]
[[license](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/LICENSE)]

### Task packaging and visibility

Each task contains `task.toml`, agent-visible `instruction.md`, an
`environment/` image definition, hidden `tests/`, and a held-out `solution/`.
The agent receives only the instruction and the prepared repository in `/app`.
Neither the task-package directory nor `tests/` nor `solution/` may be mounted
into the agent container. `solution/` is only for offline oracle review and is
not used to grade model patches.

DeepSWE v1.1 tasks declare `agent.network_mode = "no-network"`. Pier adds a
per-agent allowlist solely for the model API/install endpoints required by an
installed CLI agent; task internet remains unavailable. The repository is
checked out at the task base commit on a normal branch, with remotes, future
branches/tags, and reflogs removed. [[run guide](https://deepswe.datacurve.ai/run)]
[[Pier network model](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/README.md)]

### Isolated grading and anti-leakage rules

The agent must commit its work. A `[[verifier.collect]]` hook extracts a binary
diff against the base commit. Pier then creates a pristine verifier container,
applies that patch, and runs the hidden verifier with no network. Only declared
artifacts cross the boundary. DeepSWE v1.1 emits `reward.json`, CTRF test
results, raw verifier output, and framework logs. [[DeepSWE task format](https://github.com/datacurve-ai/deep-swe/blob/435ee89ec2f2e2289f33b0da4f992f0b7b7266b9/README.md#task-format)]
[[Harbor separate verifiers](https://www.harborframework.com/docs/tasks#verifier-environment-shared-vs-separate)]

Additional controls for this comparison:

1. Keep the benchmark checkout outside both Pi workspaces and containers.
2. Give Pi only `instruction.md` text and the task `/app` filesystem.
3. Allowlist only the exact OpenAI API hostname; deny general egress.
4. Kill Pi and all descendants before collection and verification.
5. Do not inspect `tests/`, `solution/`, verifier logs, or reference patches
   until both treatments for a scored task are immutable.
6. Never turn a task-specific observation into production logic. Preserve a
   pre-registered holdout and make acceptance decisions on aggregate behavior.
7. Quarantine `abs-module-cache-flags` and
   `optique-conditional-option-dependencies` from scored results: hidden verifier
   material was exposed while preparing and debugging this protocol.

Public availability still creates future retrieval and pretraining risk. The
no-network task phase and unpublished upstream solutions reduce, but cannot
prove the absence of, model contamination. Record the benchmark canary and
model snapshot/date with every run.

### Stock-vs-Improved execution

Implement one small Pier `BaseAgent` adapter with two immutable Pi
artifacts selected by configuration. The adapter must install the selected
artifact, run Pi headlessly on the unmodified instruction, write ATIF
`trajectory.json`, populate tokens/cost/errors in `AgentContext`, and report
the exact Pi commit as its version. Pier officially supports custom agents by
Python import path. [[custom-agent API](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/src/pier/agents/base.py)]
[[CLI import option](https://github.com/datacurve-ai/pier/blob/df89f994623a0a6a57229103b6fe910766693c30/src/pier/cli/jobs.py)]

```bash
uv tool install 'datacurve-pier==0.3.1'
git clone https://github.com/datacurve-ai/deep-swe.git /tmp/deep-swe-v1.1
git -C /tmp/deep-swe-v1.1 checkout 435ee89ec2f2e2289f33b0da4f992f0b7b7266b9

# Smoke test one non-quarantined task first.
pier run -p /tmp/deep-swe-v1.1/tasks/<task-id> \
  --agent-import-path deepswe.pi_agent:PiAgent \
  --model openai-codex/gpt-5.6-luna \
  --ak artifact_path=/abs/path/to/stock/pi \
  --ak auth_path=/abs/path/to/auth.json \
  --ak pi_commit=<stock-commit> --ak reasoning_effort=medium \
  --env docker

# Full comparison: run each command with the same fixed concurrency and seed.
pier run -p /tmp/deep-swe-v1.1/tasks \
  --agent-import-path deepswe.pi_agent:PiAgent \
  --model openai-codex/gpt-5.6-luna \
  --ak artifact_path=/abs/path/to/stock/pi \
  --ak auth_path=/abs/path/to/auth.json \
  --ak pi_commit=<stock-commit> --ak reasoning_effort=medium \
  --env docker

pier run -p /tmp/deep-swe-v1.1/tasks \
  --agent-import-path deepswe.pi_agent:PiAgent \
  --model openai-codex/gpt-5.6-luna \
  --ak artifact_path=/abs/path/to/improved/pi \
  --ak auth_path=/abs/path/to/auth.json \
  --ak pi_commit=<improved-commit> --ak reasoning_effort=medium \
  --env docker
```

Before the full run, verify the adapter's exact kwargs with `pier run --help`.
Do not override task CPU, memory, storage, timeouts, network mode, prompt, or
verifier. Freeze provider route, model snapshot, reasoning effort, Pi artifact,
Pier version, container digests, concurrency, retry policy, and run ordering.
Interleave Stock/Improved trials per task if the runner permits it; otherwise
alternate treatment order across a hash-sorted task list.

### Metrics and decision rule

Primary: equally weighted per-task pass@1, paired task-level wins/losses, and a
paired uncertainty interval. With four independent repetitions, also report
pass@4. A task timeout or context-window exhaustion is a failure; exclude only
provider, verifier, and network infrastructure errors, with counts and reasons
reported. [[DeepSWE scoring](https://arxiv.org/abs/2607.07946)]

Also report input/cache/output tokens, cost, model calls, Pi tool calls, failed
and repeated tool calls, retries, compactions, timeout/runtime, peak context,
and self-verification behavior. Do not claim a gain unless the changed mechanism
appears in winning trajectories and regressions remain within the pre-registered
acceptance bound. The official v1.1 report stopped using wall time for model
ranking because provider/host variance dominates it; retain runtime only as a
diagnostic under identical local conditions.

## Terminal-Bench 2.1 secondary protocol

- Repository commit:
  [`7131e4375048a0e408a8fb404b5f499d726b695b`](https://github.com/harbor-framework/terminal-bench-2-1/commit/7131e4375048a0e408a8fb404b5f499d726b695b).
- Canonical dataset ref:
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`.
- Dataset: `terminal-bench/terminal-bench-2-1`, 89 tasks, no official split.
- Official leaderboard protocol: full coverage, at least five trials per task,
  unchanged task resources/timeouts, errors scored as zero, and an ATIF
  trajectory for every passing trial.
- License: Apache-2.0.

Sources: [[official repository](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b)]
[[canonical ref](https://github.com/harbor-framework/terminal-bench-2-1/blob/7131e4375048a0e408a8fb404b5f499d726b695b/configs/leaderboard.yaml)]
[[official run command](https://www.tbench.ai/docs/run-terminal-bench-2-1)]
[[license](https://github.com/harbor-framework/terminal-bench-2-1/blob/7131e4375048a0e408a8fb404b5f499d726b695b/LICENSE)]

```bash
harbor run \
  -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  --agent-import-path pi_harbor_adapter:PiAgent \
  -m openai/gpt-5.6-luna \
  --ak variant=stock --ak reasoning_effort=medium \
  -e docker -k 5 -n <fixed-concurrency>
```

Repeat with only `variant=improved` changed. Record accuracy, pass@2..5,
standard error, tokens, cost, average duration, errors, and disqualification
rate; keep Pi-specific telemetry alongside it. Audit every success for online
solution lookup, hidden-test access, verifier tampering, or lingering processes.
Do not call a network-disabled TB run official-comparable because current tasks
declare internet access and some require it.

## Unresolved risks

- Both benchmark packages are public and include tests and reference solutions;
  operational isolation prevents runtime access but cannot prove pretraining
  cleanliness.
- DeepSWE has no immutable release tag at the inspected dataset commit; pin the
  full Git commit and every task digest, and archive the manifest with results.
- A Pi Pier/Harbor adapter does not yet exist in this repository. Its ATIF and
  process-termination behavior must pass deterministic leakage tests before any
  paid run.
- DeepSWE's official leaderboard used Pier, mini-swe-agent, and Modal. A Pi run
  intentionally changes the harness and may be compared Stock-vs-Improved, but
  its absolute score is not directly comparable to that leaderboard.
- The TB 2.1 announcement says 28 tasks were fixed while its repository README
  says 26 were modified. The dataset digest, not either count, is authoritative.
- Full repeated runs are expensive. Any cheaper development subset is a custom,
  pre-registered split and must not be represented as an official score.
