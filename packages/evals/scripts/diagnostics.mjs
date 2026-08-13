import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

export function buildPiInvocation({ repository, workspace, extension, model, thinking, prompt }) {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) throw new Error("Model must be provider/model.");
	return {
		command: join(repository, "pi-test.sh"),
		cwd: workspace,
		args: [
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
			"--tools",
			"bash",
			"--approve",
			"--provider",
			model.slice(0, separator),
			"--model",
			model.slice(separator + 1),
			"--thinking",
			thinking,
			"--extension",
			extension,
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
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
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
	const options = { split: "development", repetitions: 1, timeoutMs: 600_000, thinking: "medium" };
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

async function runTreatment({ name, repository, task, repetition, runRoot, supportExtension, model, thinking, timeoutMs }) {
	const workspace = join(runRoot, task.id, String(repetition), name, "workspace");
	await prepareWorkspace(resolve(packageRoot, "diagnostics", task.fixture), workspace);
	const invocation = buildPiInvocation({ repository, workspace, extension: supportExtension, model, thinking, prompt: task.prompt });
	const processResult = await runProcess(invocation.command, invocation.args, { cwd: invocation.cwd, timeoutMs });
	const telemetry = parsePiEvents(processResult.stdout);
	const verifier = await runVerifier(resolve(packageRoot, "diagnostics", task.verifier), workspace, 60_000);
	await Promise.all([
		writeFile(join(dirname(workspace), "events.jsonl"), processResult.stdout),
		writeFile(join(dirname(workspace), "stderr.log"), processResult.stderr),
	]);
	return {
		name,
		repository,
		commit: await gitCommit(repository),
		process: { exitCode: processResult.exitCode, signal: processResult.signal, timedOut: processResult.timedOut, totalMs: processResult.totalMs },
		telemetry,
		verifier: { passed: verifier.passed, tests: verifier.tests, exitCode: verifier.exitCode, timedOut: verifier.timedOut, stdout: verifier.stdout, stderr: verifier.stderr },
		solved: processResult.exitCode === 0 && !processResult.timedOut && verifier.passed,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	for (const key of ["stockRepo", "improvedRepo", "model"]) {
		if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
	}
	const manifest = validateManifest(JSON.parse(await readFile(join(packageRoot, "diagnostics", "manifest.json"), "utf8")));
	const tasks = manifest.tasks.filter((task) => options.split === "all" || task.split === options.split);
	if (tasks.length === 0) throw new Error(`No ${options.split} diagnostic tasks.`);
	const runId = `${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}`;
	const runRoot = resolve(packageRoot, ".eval", "diagnostics", runId);
	const supportRoot = join(runRoot, "support");
	await mkdir(join(supportRoot, "extensions"), { recursive: true });
	await mkdir(join(supportRoot, "src"), { recursive: true });
	await Promise.all([
		cp(join(packageRoot, "extensions", "isolated-bash.ts"), join(supportRoot, "extensions", "isolated-bash.ts")),
		cp(join(packageRoot, "src", "tool-isolation.ts"), join(supportRoot, "src", "tool-isolation.ts")),
	]);
	const results = [];
	for (const task of tasks) {
		for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
			for (const [name, repository] of [["stock", resolve(options.stockRepo)], ["improved", resolve(options.improvedRepo)]]) {
				console.error(`[diagnostic] ${task.id} repetition=${repetition} treatment=${name}`);
				results.push(await runTreatment({ name, repository, task, repetition, runRoot, supportExtension: join(supportRoot, "extensions", "isolated-bash.ts"), model: options.model, thinking: options.thinking, timeoutMs: options.timeoutMs }));
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
		protocol: { model: options.model, thinking: options.thinking, timeoutMs: options.timeoutMs, repetitions: options.repetitions, network: "disabled-in-tool-sandbox", tools: ["bash"] },
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
