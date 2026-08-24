# Development Rules

## Style

- Terse, direct, technical prose. No emojis, no filler ("Thanks @user"). Define unavoidable jargon.
- Answer the question first, before edits or implementation commands.
- On feedback/analysis requests: agree or disagree explicitly, then say what changed.
- Explain non-trivial designs as problem → example/trace → solution, stating why it's necessary vs optional complexity. Prefer concrete behavior over abstract summaries.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you haven't fully inspected, and when investigating/auditing. Never rely on search snippets for broad edits.
- No `any`. Inline single-call-site helpers. Check node_modules for external API types; don't guess.
- Top-level imports only: no inline imports (`await import()`, `import("pkg").Type`).
- Erasable TypeScript only (Node strip-only mode) in root-config-checked code (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`. Use explicit fields with constructor assignments.
- Never fix type errors by removing/downgrading code from outdated deps; upgrade the dep.
- Ask before removing functionality or code that looks intentional. No backward compatibility unless asked.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`); add defaults to `DEFAULT_EDITOR_KEYBINDINGS`/`DEFAULT_APP_KEYBINDINGS`.
- Never modify `packages/ai/src/models.generated.ts`; update `packages/ai/scripts/generate-models.ts` and regenerate. Committing the resulting diff is always OK, even with unrelated upstream metadata changes.

## Commands

- After code changes (not docs): `npm run check`, full output, no tail; fix all errors/warnings/infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless asked.
- Never run the full vitest suite: its e2e tests activate when endpoint/auth env vars are present. Non-e2e tests: `./test.sh` from repo root. Single tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (node:test): `node --test test/specific.test.ts`
- Run modified/new test files until they pass.
- `packages/coding-agent/test/suite/`: use `test/suite/harness.ts` + faux provider; no real provider APIs, keys, or paid tokens. Issue regressions live in `test/suite/regressions/<issue-number>-<short-slug>.test.ts`.
- Ad-hoc scripts: write to a temp file, run, iterate, remove. Don't embed multi-line scripts in bash commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Dep and lockfile changes are reviewed code. Direct external deps pinned to exact versions.
- Before updating `undici`, read its changelog/release notes for the target version and assess impact.
- Install/hydrate with `--ignore-scripts` (`npm ci --ignore-scripts` for clean installs); no lifecycle scripts unless asked.
- Dep metadata changes: refresh lockfile with `npm install --package-lock-only --ignore-scripts`.
- Shrinkwrap regen: `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check`). New deps with lifecycle scripts require review plus an explicit allowlist entry in that script; never add silently.
- Pre-commit blocks lockfile commits without `PI_ALLOW_LOCKFILE_CHANGE=1`; don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions share this cwd concurrently; touching others' unstaged/staged/untracked files destroys their work.

- Commit only files YOU changed THIS session. Stage explicit paths (`git add <path1> <path2>`); never `git add -A`/`git add .`. Verify with `git status` before committing. `packages/ai/src/models.generated.ts` may always be included.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <informative, concise message>`.
- NEVER run: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, force push.
- Rebase conflicts: resolve only in files you modified; if a conflict is elsewhere, abort and ask.

## Issues and PRs

- Contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar): see `CONTRIBUTING.md`.
- PR review: don't move the worktree to the PR branch unless explicitly asked. Inspect via `gh pr view/diff`, `gh api`, and `git show <ref>:<path>` against fetched refs; fetch PR file contents to temp files if needed.
- New issues: add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`).
- Comments: write to a temp file, post with `gh issue/pr comment --body-file` (never multi-line `--body`). Concise, technical, user's tone. End AI-posted comments with the AI-generated disclaimer line specified by the originating prompt.
- Closing issues via commit: repeat `fixes #<n>`/`closes #<n>` per issue; shared keywords (`closes #1, #2`) only close the first.

## Testing pi Interactive Mode (tmux)

From repo root:

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

One per package: `packages/*/CHANGELOG.md`. Sections under `## [Unreleased]`: `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, `### Removed`.

- Append to existing subsections (read the full section first; never duplicate). Released sections (e.g. `## [0.12.2]`) are immutable. No entries on branches other than `main` or PRs.
- Attribution: internal `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`; external `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`.

## Releasing

Lockstep versioning: all packages share one version, updated together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Changelogs**: the user must have run the `/cl` prompt on the latest `main` commit to audit `[Unreleased]` sections before releasing.
2. **Smoke test** an unpublished release from OUTSIDE the repo (no workspace resolution):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp
   /tmp/pi-local-release/node/pi --help       # same for --version, --list-models,
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"   # and bun variants below
   /tmp/pi-local-release/bun/pi --help        # --version, --list-models,
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   ```
   Bare `/tmp/pi-local-release/{node,bun}/pi` start interactive mode: run each in tmux, submit a prompt, wait for the model reply. Failures are release blockers unless the user accepts the risk.
3. **Release**: `PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch` (or `release:minor`). The age-gate env var is only for this command. Review lockfile/shrinkwrap diffs before push. The script bumps versions, updates changelogs, regenerates artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `[Unreleased]` sections, commits those, pushes `main` + tag. Never rerun after the tag is pushed.
4. **CI publishes and announces**: tag push triggers `.github/workflows/build-binaries.yml`; `publish-npm` uses npm trusted publishing (OIDC, environment `npm-publish`) — no local publish/OTP. `announce-pi-dev-release` verifies every public package resolves at the exact version and its tarball exists, then writes the R2 marker read by `pi.dev/api/latest-version`; it must never announce early.
5. **CI failures**: inspect the failed job. Publish helper is idempotent (skips existing versions); announcement rechecks availability. Rerun the job/workflow after fixing; never rerun the release script for the same version.

## Evaluation Evidence

- Pin source, build, evaluator/provider, task revision, and environment in every run manifest.
- Compare stock vs candidate under identical treatment; only the declared harness patch may differ.
- Report cancelled/invalid infrastructure/provider runs as blockers, never capability evidence.
- Two-tier approval for capability changes: diagnostic tier first, then a stronger end-to-end evaluator (e.g. DeepSWE) when available and affordable; otherwise record the blocker and treat diagnostics as provisional.

## Harness Research Autonomy

- Work autonomously on safe, reversible repo changes: investigation, experiments, edits, tests, commits, subagent delegation need no approval.
- Never perform dangerous/irreversible actions: force-push, shared-history rewrite, destructive deletion, credential/secrets changes, external infrastructure mutation, release publishing, protected-branch merge, billing/resource changes. Abandon such paths and continue other safe work instead of waiting.
- Delegate narrow subagents for independent exploration, verifier review, failure analysis, experiment design, or code review; synthesize their evidence before acting.

### Experiment Acceptance Criteria

1. Start from a concrete, evidence-backed failure mode or efficiency mechanism — not intuition.
2. Test one primary mechanism at a time with the smallest viable intervention.
3. Identical evaluator, task, and settings stock-vs-treatment except the declared treatment.
4. Diagnostics first (normally 5+5); promote promising or ambiguous results to 10+10.
5. Cancelled, truncated, rate-limited, provider-error, or infrastructure-failed runs are invalid evidence, never capability failures.
6. A verifier is valid only when its private checks demonstrably execute, an independent SPEC-faithful reference passes it, and deliberately faulty mutants are rejected by named checks (attribute each catch).
7. Pareto gate before accepting any change: no material solve-rate/correctness regression; complexity justified by measured benefit; bounded overhead only when capability improves; efficiency changes must keep capability non-inferior while materially improving targeted cost/variance.
8. Confirm accepted capability changes on a stronger end-to-end evaluator when practical.
9. Prefer mechanisms that generalize across evaluators; don't optimize for one specific preview model.
10. Each new benchmark task must probe a distinct unresolved mechanism, not accumulate ceiling results.
11. Keep the harness minimal: reject interventions whose measured benefit doesn't justify maintenance/behavioral complexity.
12. Commit only coherent, validated improvements with tests and relevant documentation updated.

## User Override

If the user's instructions conflict with any rule above, ask for explicit confirmation before overriding; only then execute.
