import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Extensions the mandated evaluator requires to run (provider + code-glue tool). */
export const MANDATED_EXTENSION_NAMES = ["pi-clinepass-provider", "pi-fabric"];

/**
 * Resolve the absolute install paths of the mandated evaluator extensions from an
 * agent directory's standard npm install location. Only the mandated names are
 * returned: any other ambient extension (installed under the same root) is never
 * selected, so a dummy user extension cannot change the effective runtime.
 */
export function resolveMandatedExtensionPaths(agentDir) {
	return MANDATED_EXTENSION_NAMES.map((name) => {
		const path = join(agentDir, "npm", "node_modules", name);
		if (!existsSync(path)) throw new Error(`Required evaluator extension not installed at ${path}. Enable/install ${name} first.`);
		return path;
	});
}

/**
 * Fresh-context independent verification prompt.  Invoked after the generator
 * completes normally.  The verifier receives only the original spec and the
 * workspace path — no generator conversation history, reasoning, or hints.
 */
const FRESH_CONTEXT_VERIFY_PROMPT = `You are an independent code reviewer. Your task is to verify that an implementation correctly satisfies its specification.

Original specification:
{ORIGINAL_PROMPT}

The implementation is located at: {WORKSPACE_PATH}

Instructions:
1. Read the original specification carefully
2. Identify all invariants, boundary conditions, and state-transition cases specified
3. Read the implementation files from the workspace path above
4. Compare the implementation against each identified requirement
5. Report any concrete specification violations you find

Be specific: name the invariant, show the code that violates it, and explain why.

If you find no violations, state exactly: NO VIOLATIONS FOUND

Do NOT modify any files. This is a read-only verification.`;

/**
 * Repair prompt for the original agent.  Injected when the fresh-context
 * verifier reports a plausible violation.  Gives the original agent exactly
 * one opportunity to fix the issues.
 */
const REPAIR_PROMPT_TEMPLATE = `An independent reviewer found the following specification violations in your implementation:

{VIOLATION_REPORT}

Please fix these issues and verify your fixes. This is your only repair opportunity.`;

/** Directories excluded from a provenance tree hash (depend on the version pins instead). */
const PROVENANCE_IGNORED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".idea", ".vscode"]);

/** Deterministic content/tree hash: sha256 over sorted `relpath<NUL>sha256(content)` lines. */
export function hashTree(root) {
	const lines = [];
	function walk(dir, rel) {
		for (const name of readdirSync(dir).sort()) {
			if (PROVENANCE_IGNORED_DIRS.has(name)) continue;
			const abs = join(dir, name);
			const childRel = rel === "" ? name : `${rel}/${name}`;
			const stat = statSync(abs);
			if (stat.isDirectory()) {
				walk(abs, childRel);
			} else if (stat.isFile()) {
				lines.push(`${childRel}\u0000${createHash("sha256").update(readFileSync(abs)).digest("hex")}`);
			}
		}
	}
	walk(root, "");
	const hash = createHash("sha256");
	for (const line of lines.sort()) hash.update(line).update("\n");
	return hash.digest("hex");
}

/** Resolve reproducibility metadata for an extension: path plus package version and tree hash where available. */
export function provenanceFor(extensionPath) {
	if (statSync(extensionPath).isFile()) {
		return { path: extensionPath, name: null, version: null, fileHash: hashFile(extensionPath) };
	}
	let name = null;
	let version = null;
	const manifestPath = join(extensionPath, "package.json");
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			name = manifest.name ?? null;
			version = manifest.version ?? null;
		} catch {
			// Version is best-effort; the tree hash is authoritative.
		}
	}
	return { path: extensionPath, name, version, treeHash: hashTree(extensionPath) };
}

/** sha256 of a single file (used for the copied treatment extension source). */
export function hashFile(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inside(parent, child) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export function validateManifest(manifest) {
	if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
		throw new Error("Diagnostic manifest must have schemaVersion 1 and at least one task.");
	}
	const ids = new Set();
	for (const task of manifest.tasks) {
		if (!task || typeof task.id !== "string" || !task.id || ids.has(task.id)) {
			throw new Error(`Diagnostic manifest has duplicate task id: ${task?.id ?? "(missing)"}.`);
		}
		ids.add(task.id);
		if (!["development", "holdout"].includes(task.split)) {
			throw new Error(`Task ${task.id} must select the development or holdout split.`);
		}
		for (const key of ["fixture", "verifier", "prompt"]) {
			if (typeof task[key] !== "string" || !task[key]) throw new Error(`Task ${task.id} is missing ${key}.`);
		}
		const fixture = resolve(packageRoot, "diagnostics", task.fixture);
		const verifier = resolve(packageRoot, "diagnostics", task.verifier);
		if (!inside(resolve(packageRoot, "diagnostics", "tasks"), fixture)) {
			throw new Error(`Task ${task.id} fixture must stay under diagnostics/tasks.`);
		}
		if (!inside(resolve(packageRoot, "diagnostics", "verifiers"), verifier)) {
			throw new Error(`Task ${task.id} verifier must stay outside task fixtures under diagnostics/verifiers.`);
		}
	}
	return manifest;
}

/**
 * Join a task prompt with the improved-arm intervention hint. Pure so the
 * arm-selection contract is unit-testable without launching a run.
 */
export function buildTreatmentPrompt(prompt, promptAppend) {
	return promptAppend ? `${prompt}\n\n${promptAppend}` : prompt;
}

/**
 * Arm selection for the prompt-append intervention: only the improved arm
 * receives the hint. Pure so the asymmetry contract is unit-testable.
 */
export function selectPromptAppend(treatmentName, promptAppend) {
	return treatmentName === "improved" && promptAppend ? promptAppend : null;
}

export function buildPiInvocation({ repository, workspace, requiredExtensions, model, thinking, prompt }) {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) throw new Error("Model must be provider/model.");
	if (!Array.isArray(requiredExtensions) || requiredExtensions.length === 0) {
		throw new Error("requiredExtensions must name at least one evaluator extension.");
	}
	return {
		command: join(repository, "pi-test.sh"),
		cwd: workspace,
		args: [
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--offline",
			"--approve",
			"--no-env",
			"--no-extensions",
			...requiredExtensions.flatMap((extension) => ["--extension", extension]),
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-themes",
			"--provider",
			model.slice(0, separator),
			"--model",
			model.slice(separator + 1),
			"--thinking",
			thinking,
			prompt,
		],
	};
}

function usageTotal(message, key) {
	const value = message?.usage?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parsePiEvents(stdout) {
	const events = [];
	let malformedLines = 0;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			malformedLines += 1;
		}
	}
	const toolCallKeys = new Set();
	let repeatedToolCalls = 0;
	let failedToolCalls = 0;
	let retries = 0;
	let compactions = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	let estimatedCostUsd = 0;
	let finalStopReason;
	let finalError;
	for (const event of events) {
		if (event.type === "tool_execution_start") {
			const key = JSON.stringify([event.toolName, event.args]);
			if (toolCallKeys.has(key)) repeatedToolCalls += 1;
			toolCallKeys.add(key);
		} else if (event.type === "tool_execution_end" && event.isError) failedToolCalls += 1;
		else if (event.type === "auto_retry_start") retries += 1;
		else if (event.type === "compaction_start") compactions += 1;
		else if (event.type === "message_end" && event.message?.role === "assistant") {
			inputTokens += usageTotal(event.message, "input");
			outputTokens += usageTotal(event.message, "output");
			cacheReadTokens += usageTotal(event.message, "cacheRead");
			cacheWriteTokens += usageTotal(event.message, "cacheWrite");
			totalTokens += usageTotal(event.message, "totalTokens");
			estimatedCostUsd += finiteNumber(event.message.usage?.cost?.total);
			finalStopReason = event.message.stopReason;
			finalError = event.message.errorMessage;
		}
	}
	return {
		eventCount: events.length,
		malformedLines,
		toolCalls: [...events].filter((event) => event.type === "tool_execution_start").length,
		failedToolCalls,
		repeatedToolCalls,
		retries,
		compactions,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		estimatedCostUsd,
		finalStopReason,
		finalError,
	};
}

async function runProcess(command, args, { cwd, env = process.env, timeoutMs }) {
	return await new Promise((resolvePromise) => {
		const startedAt = performance.now();
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		const stop = () => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		// Cap buffers: a model in an output loop can exceed V8's max string
		// length and crash the whole run. Keep the first 64MB; a rep that
		// produces more output than that is pathological regardless.
		const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		child.stdout.on("data", (chunk) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= MAX_CAPTURE_BYTES) stderr.push(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ exitCode: null, signal: null, timedOut, error: error.message, stdout: "", stderr: "", totalMs: performance.now() - startedAt });
		});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolvePromise({
				exitCode,
				signal,
				timedOut,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
				totalMs: performance.now() - startedAt,
			});
		});
	});
}

export async function runVerifier(verifier, workspace, timeoutMs) {
	if (!isAbsolute(verifier) || inside(workspace, verifier)) {
		throw new Error("Verifier must be an absolute path outside the task workspace.");
	}
	const processResult = await runProcess(verifier, [workspace], { cwd: dirname(verifier), timeoutMs });
	let payload = {};
	try {
		payload = JSON.parse(processResult.stdout.trim());
	} catch {}
	return { ...payload, ...processResult, passed: processResult.exitCode === 0 && payload.passed === true };
}

function parseArgs(args) {
	const options = { split: "development", repetitions: 1, timeoutMs: 600_000, thinking: "medium", intervention: "none", tasks: null };
	for (let index = 0; index < args.length; index += 1) {
		const key = args[index];
		if (key === "run") continue;
		const value = args[index + 1];
		if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
		options[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
		index += 1;
	}
	options.repetitions = Number(options.repetitions);
	options.timeoutMs = Number(options.timeoutMs);
	return options;
}

async function gitCommit(repository) {
	const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 });
	if (result.exitCode !== 0) throw new Error(`Cannot resolve ${repository}: ${result.stderr}`);
	return result.stdout.trim();
}

export async function prepareWorkspace(fixture, workspace) {
	await mkdir(dirname(workspace), { recursive: true });
	await cp(fixture, workspace, { recursive: true });
	const env = {
		...process.env,
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	};
	for (const args of [
		["init", "--quiet", "--initial-branch=main"],
		["add", "."],
		["-c", "user.name=Pi Eval", "-c", "user.email=pi-eval@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Initial task"],
	]) {
		const result = await runProcess("git", args, { cwd: workspace, env, timeoutMs: 10_000 });
		if (result.exitCode !== 0) throw new Error(`Cannot prepare task workspace: git ${args[0]} failed: ${result.stderr}`);
	}
}

export async function prepareTreatmentSupport(repository, runId) {
	const supportRoot = resolve(repository, "packages/evals/.eval/diagnostic-support", runId);
	await Promise.all([
		mkdir(join(supportRoot, "extensions"), { recursive: true }),
		mkdir(join(supportRoot, "src"), { recursive: true }),
	]);
	await Promise.all([
		cp(join(packageRoot, "extensions", "isolated-bash.ts"), join(supportRoot, "extensions", "isolated-bash.ts")),
		cp(join(packageRoot, "src", "tool-isolation.ts"), join(supportRoot, "src", "tool-isolation.ts")),
	]);
	return join(supportRoot, "extensions", "isolated-bash.ts");
}

async function runTreatment({ name, repository, task, repetition, runRoot, requiredExtensions, agentDir, sessionDir, model, thinking, timeoutMs, interventionEnabled, gateEnabled, promptAppend }) {
	const workspace = join(runRoot, task.id, String(repetition), name, "workspace");
	await prepareWorkspace(resolve(packageRoot, "diagnostics", task.fixture), workspace);
	const invocation = buildPiInvocation({ repository, workspace, requiredExtensions, model, thinking, prompt: buildTreatmentPrompt(task.prompt, promptAppend) });
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
	};
	const verifierPath = resolve(packageRoot, "diagnostics", task.verifier);

	// Phase 1: normal generator run.
	const phase1 = await runProcess(invocation.command, invocation.args, { cwd: invocation.cwd, env, timeoutMs });
	const phase1Telemetry = parsePiEvents(phase1.stdout);

	// Completion-evidence gate: detect premature abort and optionally continue.
	let gateAttemptedStop = false;
	let gatePhase1ToolCalls = 0;
	let gateContinuationRan = false;
	let gateContinuationToolCalls = 0;
	let gateContinuationResumed = false;
	let gateOverheadTokens = 0;
	let gateOverheadMs = 0;
	let phase1b = null;
	let phase1bTelemetry = null;
	const gateTriggered = gateEnabled
		&& phase1Telemetry.toolCalls < 3
		&& phase1Telemetry.finalStopReason === "stop"
		&& !phase1.timedOut;
	if (gateTriggered) {
		gateAttemptedStop = true;
		gatePhase1ToolCalls = phase1Telemetry.toolCalls;
		// Re-invoke with the same prompt in the same workspace (agent sees partial work).
		phase1b = await runProcess(invocation.command, invocation.args, { cwd: invocation.cwd, env, timeoutMs });
		phase1bTelemetry = parsePiEvents(phase1b.stdout);
		gateContinuationRan = true;
		gateContinuationToolCalls = phase1bTelemetry.toolCalls;
		gateContinuationResumed = phase1bTelemetry.toolCalls > 0;
		gateOverheadTokens = phase1bTelemetry.totalTokens;
		gateOverheadMs = phase1b.totalMs;
	}

	// Phase 2: fresh-context independent verification (improved treatment only).
	// Runs a separate agent with only the spec and workspace path — no generator history.
	let phase2 = null;
	let phase2Telemetry = null;
	let freshContextVerifierDetected = false;
	let freshContextVerifierReport = null;
	let freshContextRepairSucceeded = false;
	let phase3 = null;
	let phase3Telemetry = null;
	const triggerPhase2 = interventionEnabled && (phase1bTelemetry?.finalStopReason ?? phase1Telemetry.finalStopReason) === "stop" && !(phase1.timedOut || (phase1b?.timedOut ?? false));
	if (triggerPhase2) {
		const verifyPrompt = FRESH_CONTEXT_VERIFY_PROMPT
			.replace("{ORIGINAL_PROMPT}", task.prompt)
			.replace("{WORKSPACE_PATH}", workspace);
		// Verifier runs in its own workspace (copy of fixture), reads implementation via absolute paths.
		const verifierWorkspace = join(runRoot, task.id, String(repetition), `${name}-verifier`, "workspace");
		await prepareWorkspace(resolve(packageRoot, "diagnostics", task.fixture), verifierWorkspace);
		const phase2Invocation = buildPiInvocation({ repository, workspace: verifierWorkspace, requiredExtensions, model, thinking, prompt: verifyPrompt });
		phase2 = await runProcess(phase2Invocation.command, phase2Invocation.args, { cwd: phase2Invocation.cwd, env, timeoutMs });
		phase2Telemetry = parsePiEvents(phase2.stdout);

		// Parse verifier output for violations.
		const verifierOutput = phase2.stdout;
		freshContextVerifierDetected = !verifierOutput.includes("NO VIOLATIONS FOUND");
		if (freshContextVerifierDetected) {
			// Extract the violation report (everything after the last tool output, before final stop).
			freshContextVerifierReport = extractViolationReport(verifierOutput);
		}

		// Phase 3: if violations detected, give original agent one repair opportunity.
		if (freshContextVerifierDetected && freshContextVerifierReport) {
			const repairPrompt = REPAIR_PROMPT_TEMPLATE.replace("{VIOLATION_REPORT}", freshContextVerifierReport);
			const phase3Invocation = buildPiInvocation({ repository, workspace, requiredExtensions, model, thinking, prompt: repairPrompt });
			phase3 = await runProcess(phase3Invocation.command, phase3Invocation.args, { cwd: phase3Invocation.cwd, env, timeoutMs });
			phase3Telemetry = parsePiEvents(phase3.stdout);
		}
	}

	// Merge telemetry from all phases (phase1b = gate continuation).
	const telemetry = {
		eventCount: phase1Telemetry.eventCount + (phase1bTelemetry?.eventCount ?? 0) + (phase2Telemetry?.eventCount ?? 0) + (phase3Telemetry?.eventCount ?? 0),
		toolCalls: phase1Telemetry.toolCalls + (phase1bTelemetry?.toolCalls ?? 0) + (phase2Telemetry?.toolCalls ?? 0) + (phase3Telemetry?.toolCalls ?? 0),
		failedToolCalls: phase1Telemetry.failedToolCalls + (phase1bTelemetry?.failedToolCalls ?? 0) + (phase2Telemetry?.failedToolCalls ?? 0) + (phase3Telemetry?.failedToolCalls ?? 0),
		repeatedToolCalls: phase1Telemetry.repeatedToolCalls + (phase1bTelemetry?.repeatedToolCalls ?? 0) + (phase2Telemetry?.repeatedToolCalls ?? 0) + (phase3Telemetry?.repeatedToolCalls ?? 0),
		retries: phase1Telemetry.retries + (phase1bTelemetry?.retries ?? 0) + (phase2Telemetry?.retries ?? 0) + (phase3Telemetry?.retries ?? 0),
		compactions: phase1Telemetry.compactions + (phase1bTelemetry?.compactions ?? 0) + (phase2Telemetry?.compactions ?? 0) + (phase3Telemetry?.compactions ?? 0),
		inputTokens: phase1Telemetry.inputTokens + (phase1bTelemetry?.inputTokens ?? 0) + (phase2Telemetry?.inputTokens ?? 0) + (phase3Telemetry?.inputTokens ?? 0),
		outputTokens: phase1Telemetry.outputTokens + (phase1bTelemetry?.outputTokens ?? 0) + (phase2Telemetry?.outputTokens ?? 0) + (phase3Telemetry?.outputTokens ?? 0),
		cacheReadTokens: phase1Telemetry.cacheReadTokens + (phase1bTelemetry?.cacheReadTokens ?? 0) + (phase2Telemetry?.cacheReadTokens ?? 0) + (phase3Telemetry?.cacheReadTokens ?? 0),
		cacheWriteTokens: phase1Telemetry.cacheWriteTokens + (phase1bTelemetry?.cacheWriteTokens ?? 0) + (phase2Telemetry?.cacheWriteTokens ?? 0) + (phase3Telemetry?.cacheWriteTokens ?? 0),
		totalTokens: phase1Telemetry.totalTokens + (phase1bTelemetry?.totalTokens ?? 0) + (phase2Telemetry?.totalTokens ?? 0) + (phase3Telemetry?.totalTokens ?? 0),
		estimatedCostUsd: phase1Telemetry.estimatedCostUsd + (phase1bTelemetry?.estimatedCostUsd ?? 0) + (phase2Telemetry?.estimatedCostUsd ?? 0) + (phase3Telemetry?.estimatedCostUsd ?? 0),
		finalStopReason: phase3Telemetry?.finalStopReason ?? phase2Telemetry?.finalStopReason ?? phase1bTelemetry?.finalStopReason ?? phase1Telemetry.finalStopReason,
		finalError: phase3Telemetry?.finalError ?? phase2Telemetry?.finalError ?? phase1bTelemetry?.finalError ?? phase1Telemetry.finalError,
		freshContextVerificationDetected: triggerPhase2 && freshContextVerifierDetected,
		freshContextRepairSucceeded: freshContextRepairSucceeded,
	};

	// Verifier runs once on the final workspace state (after repair if it ran).
	const verifier = await runVerifier(verifierPath, workspace, 60_000);
	const totalMs = phase1.totalMs + (phase1b?.totalMs ?? 0) + (phase2?.totalMs ?? 0) + (phase3?.totalMs ?? 0);
	const finalPhase = phase3 ?? phase2 ?? phase1b ?? phase1;

	await Promise.all([
		writeFile(join(dirname(workspace), "events.jsonl"), [phase1, phase1b, phase2, phase3].filter(Boolean).map((p) => p.stdout).join("\n")),
		writeFile(join(dirname(workspace), "stderr.log"), [phase1, phase1b, phase2, phase3].filter(Boolean).map((p) => p.stderr).join("\n")),
	]);
	const phases = [phase1, phase1b, phase2, phase3].filter(Boolean);
	const providerNoise = classifyProviderNoise(telemetry.totalTokens, phases.map((phase) => parsePiEvents(phase.stdout).finalError));
	return {
		name,
		taskId: task.id,
		split: task.split,
		repetition,
		repository,
		commit: await gitCommit(repository),
		effectiveConfig: {
			model,
			thinking,
			agentDir,
			environment: "isolated (launcher --no-env strips ambient API keys)",
			extensions: { required: requiredExtensions },
			skills: [],
			tools: "default-builtin",
			configFiles: { contextFiles: "disabled", promptTemplates: "disabled", themes: "disabled" },
		},
		process: { exitCode: finalPhase.exitCode, signal: finalPhase.signal, timedOut: phases.some((phase) => phase.timedOut), totalMs },
		telemetry,
		verifier: { passed: verifier.passed, tests: verifier.tests, exitCode: verifier.exitCode, timedOut: verifier.timedOut, stdout: verifier.stdout, stderr: verifier.stderr },
		solved:
			finalPhase.exitCode === 0 &&
			!phases.some((phase) => phase.timedOut) &&
			!providerNoise &&
			verifier.passed,
		providerNoise,
		freshContextVerifierReport: freshContextVerifierReport ?? null,
		gate: {
			attemptedStop: gateAttemptedStop,
			phase1ToolCalls: gatePhase1ToolCalls,
			continuationRan: gateContinuationRan,
			continuationToolCalls: gateContinuationToolCalls,
			continuationResumed: gateContinuationResumed,
			overheadTokens: gateOverheadTokens,
			overheadMs: Math.round(gateOverheadMs),
		},
	};
}

/**
 * Infra noise, not task evidence: a rep where every phase consumed zero
 * tokens settled on empty provider responses, or a phase ended mid-stream
 * without a finish_reason ("Stream ended without finish_reason").
 */
export function classifyProviderNoise(totalTokens, finalErrors) {
	if (totalTokens === 0) return true;
	return finalErrors.some((error) => typeof error === "string" && error.includes("Stream ended without finish_reason"));
}

/**
 * Extract the violation report from the fresh-context verifier's stdout.
 * Takes everything after the last tool_execution_end that isn't "NO VIOLATIONS FOUND".
 */
function extractViolationReport(stdout) {
	const lines = stdout.split("\n");
	const reportLines = [];
	let capturing = false;
	for (const line of lines) {
		if (line.includes("NO VIOLATIONS FOUND")) return null;
		if (line.includes("specification violations") || line.includes("violates") || line.includes("invariant")) {
			capturing = true;
		}
		if (capturing) reportLines.push(line);
	}
	if (reportLines.length === 0) {
		// Fallback: grab the last substantial assistant message.
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			if (lines[i].trim().length > 20) return lines[i].trim();
		}
		return null;
	}
	return reportLines.join("\n").trim();
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	for (const key of ["stockRepo", "improvedRepo", "model"]) {
		if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
	}
	if (options.promptAppend && options.intervention && options.intervention !== "none") {
		throw new Error("--prompt-append and --intervention are mutually exclusive: one treatment mechanism per experiment.");
	}
	const manifest = validateManifest(JSON.parse(await readFile(join(packageRoot, "diagnostics", "manifest.json"), "utf8")));
	const tasks = manifest.tasks.filter((task) => {
		if (options.split !== "all" && task.split !== options.split) return false;
		if (options.tasks) {
			const allowed = new Set(options.tasks.split(","));
			if (!allowed.has(task.id)) return false;
		}
		return true;
	});
	if (tasks.length === 0) throw new Error(`No ${options.split} diagnostic tasks.`);
	const runId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
	const runRoot = resolve(packageRoot, ".eval", "diagnostics", runId);
	const defaultAgentDir = join(homedir(), ".pi", "agent");
	const requiredExtensions = resolveMandatedExtensionPaths(defaultAgentDir);
	const agentDirs = { stock: join(runRoot, "agent-stock"), improved: join(runRoot, "agent-improved") };
	const sessionDirs = { stock: join(runRoot, "session-stock"), improved: join(runRoot, "session-improved") };
	const authSource = join(defaultAgentDir, "auth.json");
	if (!existsSync(authSource)) {
		throw new Error(`Mandated evaluator credential missing: ${authSource}. Log into clinepass (pi /login or pi login) first.`);
	}
	await Promise.all(
		Object.values(agentDirs).map(async (dir) => {
			await mkdir(dir, { recursive: true });
			await copyFile(authSource, join(dir, "auth.json"));
		}),
	);
	const isolationSupportPath = await prepareTreatmentSupport(resolve(options.improvedRepo), runId);
	const isolationSupportProvenance = { path: isolationSupportPath, fileHash: hashFile(isolationSupportPath) };
	// Arms must be mechanically identical except for the mechanism under test:
	// every extension (including the sandbox treatment support) loads on BOTH arms.
	// The gate experiment differs from stock only by --intervention completion-evidence-gate.
	const armExtensions = [...requiredExtensions, isolationSupportPath];
	const requiredProvenance = requiredExtensions.map(provenanceFor);
	const tasksProvenance = tasks.map((task) => ({ id: task.id, fixture: task.fixture, hash: hashTree(resolve(packageRoot, "diagnostics", task.fixture)) }));
	const treatments = await Promise.all(
		[
			["stock", resolve(options.stockRepo)],
			["improved", resolve(options.improvedRepo)],
		].map(([name, repository]) => ({
			name,
			repository,
			requiredExtensions: armExtensions,
			agentDir: agentDirs[name],
			sessionDir: sessionDirs[name],
		})),
	);
	const promptAppendEnabled = Boolean(options.promptAppend);
	const interventionEnabled = options.intervention === "semantic-verify" || options.intervention === "fresh-context-verify";
	const gateEnabled = options.intervention === "completion-evidence-gate";
	const results = [];
	for (const task of tasks) {
		for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
			for (const treatment of treatments) {
				console.error(`[diagnostic] ${task.id} repetition=${repetition} treatment=${treatment.name}`);
				results.push(await runTreatment({ task, repetition, runRoot, model: options.model, thinking: options.thinking, timeoutMs: options.timeoutMs, interventionEnabled: interventionEnabled && treatment.name === "improved", gateEnabled: gateEnabled && treatment.name === "improved", promptAppend: selectPromptAppend(treatment.name, options.promptAppend), ...treatment }));
			}
		}
	}
	const record = {
		schemaVersion: 1,
		runId,
		timestamp: new Date().toISOString(),
		baseline: { repository: resolve(options.stockRepo), commit: await gitCommit(resolve(options.stockRepo)) },
		parent: await gitCommit(resolve(options.improvedRepo)),
		failureEvidence: options.failureEvidence ?? null,
		hypothesis: options.hypothesis ?? null,
		predictedBehavior: options.prediction ?? null,
		change: options.change ?? null,
		tests: tasks.map(({ id, split }) => ({ id, split })),
		protocol: {
			model: options.model,
			thinking: options.thinking,
			timeoutMs: options.timeoutMs,
			repetitions: options.repetitions,
			network: "disabled-in-tool-sandbox",
			tools: "default-builtin",
			skills: [],
			env: "isolated (launcher --no-env strips ambient API keys)",
			intervention: gateEnabled ? "completion-evidence-gate" : interventionEnabled ? (options.intervention ?? "none") : promptAppendEnabled ? "prompt-append" : "none",
		},
		runtime: {
			agentDir: agentDirs,
			sessionDir: sessionDirs,
			environment: "isolated",
			extensions: {
				required: requiredProvenance,
				isolationSupport: isolationSupportProvenance,
				armExtensions: armExtensions.map(provenanceFor),
				ambientBlocked: true,
			},
			model: options.model,
			thinking: options.thinking,
			commit: await gitCommit(resolve(options.stockRepo)),
		},
		provenance: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			treatment: promptAppendEnabled ? { stock: null, improved: { promptAppend: options.promptAppend } } : { stock: null, improved: null },
			tasks: tasksProvenance,
		},
		results,
		regressions: [],
		efficiency: null,
		verdict: options.verdict ?? "pending-analysis",
	};
	await writeFile(join(runRoot, "summary.json"), `${JSON.stringify(record, null, 2)}\n`);
	await appendFile(join(packageRoot, "EXPERIMENTS.jsonl"), `${JSON.stringify(record)}\n`);
	console.log(JSON.stringify(record, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
