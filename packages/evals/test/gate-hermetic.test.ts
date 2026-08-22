import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runTreatment } from "../scripts/diagnostics.mjs";

const execFileAsync = promisify(execFile);
/**
 * Hermetic gate test: drives runTreatment end to end with a fake pi launcher
 * (pi-test.sh replaced by a shell script emitting canned JSON events) and a
 * real verifier. Exercises the completion-evidence-gate path without any
 * provider.
 *
 * Acceptance criteria covered:
 * - snapshot runs on an ISOLATED COPY (live workspace untouched by observation)
 * - phase1Solved / phase1VerifierValid are recorded separately
 * - continuationResumed is only true when the snapshot completed validly,
 *   phase 1 did NOT solve, and the continuation actually made tool calls
 * - snapshot wall time is exposed as gate.phase1VerifierMs and counted in totalMs
 *
 * The fake launcher distinguishes phase 1 from the gate continuation via the
 * PI_DIAGNOSTIC_STATE_FILE env var that runTreatment injects per repetition.
 */

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PASSING_VERIFIER =
	'#!/usr/bin/env python3\nimport json, pathlib, sys\np = pathlib.Path(sys.argv[1])\nprint(json.dumps({"passed": (p / "answer.txt").read_text().strip() == "ok", "tests": 1}))\n';
const CRASHING_VERIFIER = "#!/usr/bin/env python3\nimport sys\nsys.exit(3)\n";
const STATE = "$PI_DIAGNOSTIC_STATE_FILE";

/** Assistant message_end event; stopReason lives on the message. */
function assistantEvent(input: number, output: number): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { input, output, cacheRead: 0, totalTokens: input + output },
		},
	});
}

function toolCallEvent(toolName: string): string {
	return JSON.stringify({ type: "tool_execution_start", toolName, args: "x" });
}

function shLine(value: string): string {
	return `echo '${value.replaceAll("'", "'\\''")}'`;
}

interface Harness {
	repository: string;
	runRoot: string;
	fixture: string;
}

async function makeHarness(verifier: string, agentScript: string): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-gate-hermetic-"));
	roots.push(root);
	const repository = join(root, "repo");
	const fixture = join(root, "fixture");
	const runRoot = join(root, "run");
	await mkdir(join(repository, "bin"), { recursive: true });
	await mkdir(fixture, { recursive: true });
	await mkdir(runRoot, { recursive: true });
	await writeFile(join(fixture, "answer.txt"), "wrong\n");
	const verifierPath = join(root, "verify.py");
	await writeFile(verifierPath, verifier);
	await chmod(verifierPath, 0o755);
	await writeFile(join(repository, "bin", "dummy-extension.ts"), "export {};\n");
	await writeFile(join(repository, "pi-test.sh"), ["#!/bin/sh", ...agentScript.split("\n")].join("\n"));
	await chmod(join(repository, "pi-test.sh"), 0o755);
	// runTreatment records the repository commit; the fake repo must be a git repo.
	await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
	await execFileAsync("git", ["add", "."], { cwd: repository });
	await execFileAsync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "init"],
		{ cwd: repository },
	);
	return { repository, runRoot, fixture };
}

function treatmentInput(harness: Harness) {
	return {
		name: "improved",
		repository: harness.repository,
		task: {
			id: "gate-task",
			split: "development" as const,
			fixture: harness.fixture,
			verifier: join(harness.runRoot, "..", "verify.py"),
			prompt: "make answer.txt say ok",
		},
		repetition: 1,
		runRoot: harness.runRoot,
		requiredExtensions: [join(harness.repository, "bin", "dummy-extension.ts")],
		agentDir: join(harness.runRoot, "agent"),
		sessionDir: join(harness.runRoot, "session"),
		model: "fake/model",
		thinking: "medium",
		timeoutMs: 30_000,
		interventionEnabled: false,
		gateEnabled: false,
		promptAppend: null,
	};
}

describe("completion-evidence-gate hermetic behavior", () => {
	it("snapshots an isolated copy and records a valid unsolved phase 1 with resumed continuation", async () => {
		const harness = await makeHarness(
			PASSING_VERIFIER,
			[
				`if [ ! -f "${STATE}" ]; then`,
				`  echo ran > "${STATE}"`,
				shLine(toolCallEvent("bash")),
				shLine(assistantEvent(10, 5)),
				"else",
				'  echo ok > "$PWD/answer.txt"',
				shLine(toolCallEvent("edit")),
				shLine(assistantEvent(20, 8)),
				"fi",
			].join("\n"),
		);

		const result = await runTreatment({ ...treatmentInput(harness), gateEnabled: true });

		expect(result.gate.attemptedStop).toBe(true);
		expect(result.gate.phase1ToolCalls).toBe(1);
		expect(result.gate.phase1Solved).toBe(false);
		expect(result.gate.phase1VerifierValid).toBe(true);
		expect(result.gate.continuationRan).toBe(true);
		expect(result.gate.continuationToolCalls).toBe(1);
		expect(result.gate.continuationResumed).toBe(true);
		// Snapshot must not leave artifacts behind.
		await expect(
			readFile(
				join(harness.runRoot, "gate-task", "1", "improved", "workspace-phase1-snapshot", "answer.txt"),
				"utf8",
			),
		).rejects.toThrow();
		// Live workspace fixed by continuation -> final verification passes.
		expect(result.solved).toBe(true);
		expect(result.gate.overheadTokens).toBe(28);
		expect(result.gate.phase1VerifierMs).toBeGreaterThanOrEqual(0);
	}, 60_000);

	it("does not resume when the phase-1 snapshot already solved the task", async () => {
		const harness = await makeHarness(
			PASSING_VERIFIER,
			[
				// Premature stop but work complete: verifier passes on the snapshot copy.
				'echo ok > "$PWD/answer.txt"',
				shLine(toolCallEvent("edit")),
				shLine(assistantEvent(10, 5)),
			].join("\n"),
		);

		const result = await runTreatment({ ...treatmentInput(harness), gateEnabled: true });

		expect(result.gate.attemptedStop).toBe(true);
		expect(result.gate.phase1Solved).toBe(true);
		expect(result.gate.phase1VerifierValid).toBe(true);
		expect(result.gate.continuationRan).toBe(true);
		expect(result.gate.continuationResumed).toBe(false);
	}, 60_000);

	it("marks invalid snapshots when the verifier crashes instead of answering", async () => {
		const harness = await makeHarness(
			CRASHING_VERIFIER,
			[
				'echo wrong-but-present > "$PWD/answer.txt"',
				shLine(toolCallEvent("bash")),
				shLine(assistantEvent(10, 5)),
			].join("\n"),
		);

		const result = await runTreatment({ ...treatmentInput(harness), gateEnabled: true });

		expect(result.gate.attemptedStop).toBe(true);
		// Verifier crashed: not solved and NOT attributable evidence.
		expect(result.gate.phase1Solved).toBe(false);
		expect(result.gate.phase1VerifierValid).toBe(false);
		expect(result.gate.continuationResumed).toBe(false);
	}, 60_000);

	it("never triggers without the gate flag", async () => {
		const harness = await makeHarness(
			PASSING_VERIFIER,
			['echo whatever > "$PWD/answer.txt"', shLine(assistantEvent(10, 5))].join("\n"),
		);

		const result = await runTreatment(treatmentInput(harness));

		expect(result.gate.attemptedStop).toBe(false);
		expect(result.gate.phase1Solved).toBeNull();
		expect(result.gate.phase1VerifierValid).toBe(false);
		expect(result.gate.phase1VerifierMs).toBe(0);
	}, 60_000);
});
