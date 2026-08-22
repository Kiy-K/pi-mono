import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildPiInvocation,
	classifyProviderNoise,
	parsePiEvents,
	prepareTreatmentSupport,
	prepareWorkspace,
	runVerifier,
	validateManifest,
} from "../scripts/diagnostics.mjs";
import {
	assertComparableTrials,
	classifyOutcome,
	makeRunManifest,
	preflightEvaluator,
} from "../scripts/evaluation-contract.mjs";

const stockTrial = {
	sourceAnchor: "21f0bea88fdfbf5967497a4e8864eddaec11a310",
	artifactSha256: "a".repeat(64),
	evaluatorSha256: "b".repeat(64),
	configSha256: "c".repeat(64),
	provider: "clinepass",
	model: "deepseek-v4-flash",
	thinking: "medium",
	taskRevision: "fixture-v1",
	prompt: "Fix it.",
	tools: ["bash"],
	timeoutMs: 600_000,
};

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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

describe("evaluation contract", () => {
	it("classifies cancelled and invalid attempts outside capability evidence", () => {
		expect(classifyOutcome({ cancelled: true })).toBe("cancelled_user");
		expect(classifyOutcome({ providerError: "401 unauthorized" })).toBe("invalid_provider");
		expect(classifyOutcome({ processTimedOut: true, verifierPassed: false })).toBe("timeout_harness");
		expect(classifyOutcome({ processExitedCleanly: true, verifierPassed: true })).toBe("solved");
	});

	it("rejects a stock/candidate pair with mismatched model configuration", () => {
		expect(() => assertComparableTrials(stockTrial, { ...stockTrial, model: "other/model" })).toThrow(/model/i);
	});

	it("records immutable evaluator and treatment identity before execution", () => {
		const manifest = makeRunManifest({
			runId: "run-1",
			stock: stockTrial,
			candidate: { ...stockTrial, artifactSha256: "d".repeat(64) },
			runOrder: ["stock", "candidate"],
			outcome: "unsolved",
		});

		expect(manifest).toMatchObject({
			schemaVersion: 2,
			runId: "run-1",
			sourceAnchor: stockTrial.sourceAnchor,
			stock: { artifactSha256: stockTrial.artifactSha256 },
			candidate: { artifactSha256: "d".repeat(64) },
			evaluator: { artifactSha256: stockTrial.evaluatorSha256, configSha256: stockTrial.configSha256 },
			runOrder: ["stock", "candidate"],
			outcome: "unsolved",
		});
	});

	it("blocks a benchmark before launch when the external evaluator is not pinned locally", async () => {
		await expect(preflightEvaluator(new URL("../evaluator.json", import.meta.url))).resolves.toMatchObject({
			status: "blocked",
			reason: expect.stringMatching(/missing/i),
		});
	});
});

it("keeps treatment settings identical except for repository, result identity, and the treatment extension", () => {
	const common = {
		workspace: "/tmp/task",
		requiredExtensions: ["/tmp/clinepass", "/tmp/fabric"],
		model: "openai-codex/gpt-5.3-codex-spark",
		thinking: "medium",
		prompt: "Fix the bug and run the tests.",
	};
	const stock = buildPiInvocation({ ...common, repository: "/tmp/stock" });
	const improved = buildPiInvocation({
		...common,
		repository: "/tmp/improved",
		treatmentExtension: "/tmp/support/isolated-bash.ts",
	});
	const improvedWithoutTreatment = buildPiInvocation({ ...common, repository: "/tmp/improved" });

	// Command differs only by repo; cwd identical.
	expect(stock.cwd).toBe(improved.cwd);
	expect(stock.command).toBe("/tmp/stock/pi-test.sh");
	expect(improved.command).toBe("/tmp/improved/pi-test.sh");

	// Stock never receives the treatment extension; improved carries it exactly once.
	expect(stock.args).not.toContain("/tmp/support/isolated-bash.ts");
	expect(improved.args.filter((arg) => arg === "/tmp/support/isolated-bash.ts")).toHaveLength(1);

	// The two mandated extensions are pinned in every invocation (improved adds a third, its treatment).
	for (const invocation of [stock, improvedWithoutTreatment]) {
		expect(invocation.args.filter((arg) => arg === "--extension")).toHaveLength(2);
		expect(invocation.args).toContain("/tmp/clinepass");
		expect(invocation.args).toContain("/tmp/fabric");
	}
	expect(improved.args.filter((arg) => arg === "--extension")).toHaveLength(3);
	expect(improved.args).toContain("/tmp/clinepass");
	expect(improved.args).toContain("/tmp/fabric");

	// With treatment disabled both treatments are identical (excluding repository).
	const stockNoTreatment = buildPiInvocation({ ...common, repository: "/tmp/stock" });
	expect(improvedWithoutTreatment.args).toEqual(stockNoTreatment.args);
	expect(improvedWithoutTreatment.cwd).toBe(stockNoTreatment.cwd);
});

it("prepares each task as a clean committed Git repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-diagnostic-workspace-test-"));
	roots.push(root);
	const fixture = join(root, "fixture");
	const workspace = join(root, "workspace");
	await mkdir(fixture);
	await writeFile(join(fixture, "bug.py"), "broken = True\n");

	await prepareWorkspace(fixture, workspace);

	const [{ stdout: head }, { stdout: status }] = await Promise.all([
		execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace }),
		execFileAsync("git", ["status", "--porcelain"], { cwd: workspace }),
	]);
	expect(head.trim()).toMatch(/^[0-9a-f]{40}$/);
	expect(status).toBe("");
});

it("places identical eval support inside each treatment repository", async () => {
	const repository = await mkdtemp(join(tmpdir(), "pi-diagnostic-support-test-"));
	roots.push(repository);

	const extension = await prepareTreatmentSupport(repository, "run-1");

	expect(extension).toBe(
		join(repository, "packages/evals/.eval/diagnostic-support/run-1/extensions/isolated-bash.ts"),
	);
	expect(await readFile(extension, "utf8")).toContain("createIsolatedBashOperations");
	expect(
		await readFile(join(repository, "packages/evals/.eval/diagnostic-support/run-1/src/tool-isolation.ts"), "utf8"),
	).toContain('"--unshare-net"');
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

describe("provider noise classification", () => {
	it("flags zero-token reps as noise", () => {
		expect(classifyProviderNoise(0, [])).toBe(true);
		expect(classifyProviderNoise(0, [undefined])).toBe(true);
	});

	it("flags stream-truncated phases as noise regardless of token count", () => {
		expect(classifyProviderNoise(5000, ["Stream ended without finish_reason"])).toBe(true);
		expect(classifyProviderNoise(5000, [undefined, "429: quota exceeded"])).toBe(false);
	});

	it("treats normal completions as valid evidence", () => {
		expect(classifyProviderNoise(12_345, [undefined, "stop"])).toBe(false);
		expect(classifyProviderNoise(1, [])).toBe(false);
	});
});
