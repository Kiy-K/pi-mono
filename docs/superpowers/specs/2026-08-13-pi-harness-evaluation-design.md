# Pi Harness Evaluation Design

## Goal

Establish a reproducible Stock-vs-Improved coding-agent evaluation loop before changing Pi's runtime behavior.

## Baseline

Stock is the clean checkout at `581d75a89cea21e50d6a26df840352f94427f633`. The frozen checkout lives outside the agent task workspaces. Every comparison uses `openai-codex/gpt-5.6-luna` with the same reasoning level, prompt, tool, timeout, environment, and evaluator.

## Isolation

The Pi host process keeps provider access. Model-issued shell commands run through a shared eval extension backed by bubblewrap. The sandbox exposes a read-only system root, hides host user directories, provides a fresh `/tmp`, disables networking, and mounts only the task workspace writable at `/tmp/workspace`. Startup probes fail closed before a paid run.

## Evaluation

An external runner copies each task fixture into a fresh workspace, invokes either stock or improved Pi in JSON mode, and runs the verifier after Pi exits. Verifiers and expected behavior remain outside the model-visible workspace. Session output and measurements are retained as artifacts.

Development tasks may guide changes. Holdout tasks are not inspected while selecting or implementing a hypothesis. No production behavior may identify benchmark tasks.

## Experiment Record

Each experiment appends one JSON object containing the baseline, failure evidence, hypothesis, prediction, change, tests, per-treatment results, regressions, efficiency metrics, and verdict. Failed and reverted experiments remain in history.

## Change Gate

A runtime change is eligible only when a stock trajectory exposes a recurring harness failure, a deterministic regression fails first, and the mechanism is exercised in the comparison. Accept only task-level improvement without unacceptable regressions; otherwise revise or revert.
