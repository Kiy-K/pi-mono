import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiInvocation, parsePiEvents, runVerifier, validateManifest } from "../scripts/diagnostics.mjs";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic manifest", () => {
	it("rejects duplicate task IDs and workspace-contained verifiers", () => {
		expect(() =>
			validateManifest({
				schemaVersion: 1,
				tasks: [
					{
						id: "same",
						fixture: "tasks/a",
						verifier: "tasks/a/verify.py",
						prompt: "fix it",
						split: "development",
					},
					{ id: "same", fixture: "tasks/b", verifier: "verifiers/b.py", prompt: "fix it", split: "holdout" },
				],
			}),
		).toThrow(/duplicate task id|verifier.*outside/i);
	});
});

it("keeps treatment settings identical except for repository and result identity", () => {
	const common = {
		workspace: "/tmp/task",
		extension: "/tmp/support/isolated-bash.ts",
		model: "openai-codex/gpt-5.6-luna",
		thinking: "medium",
		prompt: "Fix the bug and run the tests.",
	};
	const stock = buildPiInvocation({ ...common, repository: "/tmp/stock" });
	const improved = buildPiInvocation({ ...common, repository: "/tmp/improved" });

	expect(stock.args).toEqual(improved.args);
	expect(stock.cwd).toBe(improved.cwd);
	expect(stock.command).toBe("/tmp/stock/pi-test.sh");
	expect(improved.command).toBe("/tmp/improved/pi-test.sh");
});

it("collects complete usage and reliability telemetry from JSON events", () => {
	const events = [
		{ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "pytest" } },
		{ type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: {}, isError: true },
		{ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "pytest" } },
		{ type: "tool_execution_end", toolCallId: "2", toolName: "bash", result: {}, isError: false },
		{ type: "auto_retry_start", attempt: 1 },
		{ type: "compaction_start", reason: "threshold" },
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 40,
					cacheWrite: 0,
					totalTokens: 160,
					cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
				},
			},
		},
	];

	expect(parsePiEvents(events.map((event) => JSON.stringify(event)).join("\n"))).toMatchObject({
		toolCalls: 2,
		failedToolCalls: 1,
		repeatedToolCalls: 1,
		retries: 1,
		compactions: 1,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 40,
		totalTokens: 160,
		estimatedCostUsd: 0.31,
		finalStopReason: "stop",
	});
});

it("runs verifiers outside the task workspace and preserves their JSON result", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-diagnostic-verifier-test-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const verifier = join(root, "verify.py");
	await mkdir(workspace);
	await writeFile(join(workspace, "answer.txt"), "42\n");
	await writeFile(
		verifier,
		'#!/usr/bin/env python3\nimport json, pathlib, sys\np = pathlib.Path(sys.argv[1])\nprint(json.dumps({"passed": (p / "answer.txt").read_text().strip() == "42", "tests": 1}))\n',
	);
	await chmod(verifier, 0o755);

	const result = await runVerifier(verifier, workspace, 5_000);

	expect(result).toMatchObject({ passed: true, tests: 1, exitCode: 0, timedOut: false });
	expect(await readFile(join(workspace, "answer.txt"), "utf8")).toBe("42\n");
});
