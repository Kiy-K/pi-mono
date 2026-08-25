#!/usr/bin/env node
/**
 * Benchmark runner for providers that authenticate via pi's own auth store
 * (e.g. opencode models with an API key) instead of the mandated clinepass
 * evaluator extensions. Bypasses diagnostics.mjs main()'s mandated-evaluator
 * gate; reuses runTreatment unchanged so telemetry (including
 * completionSignature) is identical to mandated runs.
 *
 * `--arm both` runs a real A/B of the preregistered spec-verification
 * append (diagnostics/interventions/spec-verification-append.md): the
 * directive is appended to the improved arm's prompt only; stock gets the
 * bare task prompt. Both arms are otherwise mechanically identical.
 *
 * Isolation: pi-test.sh --no-env still strips ambient API keys; the model
 * key lives in the benchmark agent dir's auth.json, never in the rep env.
 *
 * Usage:
 *   node scripts/benchmark-model.mjs --model opencode/x-preview-f-free \
 *     --tasks cart-promotions --reps 5 [--thinking medium] [--arm both]
 *
 * The model key is read from OPENCODE_API_KEY (or --auth-file pointing at a
 * JSON {"apiKey": "..."} file); the gitignored repo-root .env is loaded if
 * present (existing process env wins). Nothing is written to
 * EXPERIMENTS.jsonl; results land in .eval/benchmarks/<runId>/summary.json
 * for curation.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashFile, hashTree, prepareTreatmentSupport, runTreatment } from "./diagnostics.mjs";

const packageRoot = resolve(import.meta.dirname, "..");

// Load the gitignored repo-root .env (KEY=value lines) if present. Existing
// process env wins; values are never logged.
function loadDotEnv(path) {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
	}
}
loadDotEnv(resolve(packageRoot, "..", "..", ".env"));

// The preregistered spec-verification directive (spec-verification-append.md,
// 2026-08-24). Applied ONLY to the improved arm via --arm both.
const SPEC_VERIFICATION_APPEND =
	"After your current work appears complete: re-read SPEC.md and check every " +
	"normative rule against your implementation — especially error cases the " +
	"bundled tests do not check. Fix any mismatch, then run the available tests again.";

function parseArgs(args) {
	const options = { tasks: null, reps: 5, thinking: "medium", arm: "stock", authFile: null };
	for (let index = 0; index < args.length; index += 1) {
		const key = args[index];
		if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
		const value = args[index + 1];
		if (value === undefined) throw new Error(`Missing value for ${key}`);
		options[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toLowerCase())] = value;
		index += 1;
	}
	options.reps = Number(options.reps);
	if (!options.model || !options.model.includes("/")) throw new Error("--model provider/model required.");
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const apiKey = options.authFile
		? JSON.parse(await readFile(options.authFile, "utf8")).apiKey
		: process.env.OPENCODE_API_KEY;
	if (!apiKey) throw new Error("Provide the model key via OPENCODE_API_KEY or --auth-file {\"apiKey\": ...}.");

	const manifest = JSON.parse(await readFile(join(packageRoot, "diagnostics", "manifest.json"), "utf8"));
	const wanted = options.tasks ? new Set(options.tasks.split(",")) : null;
	const tasks = manifest.tasks.filter((task) => !wanted || wanted.has(task.id));
	if (tasks.length === 0) throw new Error("No matching tasks.");

	const runId = `${new Date().toISOString().replaceAll(":", "-")}_bench_${randomUUID().slice(0, 8)}`;
	const runRoot = resolve(packageRoot, ".eval", "benchmarks", runId);
	const repository = resolve(process.cwd());
	if (!existsSync(join(repository, "pi-test.sh"))) throw new Error(`Run from the repository root; ${repository} has no pi-test.sh.`);

	// Benchmark agent dir: pi reads provider API keys from this auth store.
	// Lives in a temp dir and is deleted after the run - the key must never
	// persist inside the repository (.eval is not trusted storage for secrets).
	const agentDir = await mkdtemp(join(tmpdir(), "pi-bench-agent-"));
	const arms = options.arm === "both" ? ["stock", "improved"] : [options.arm];
	const results = [];
	const isolationSupportPath = await prepareTreatmentSupport(repository, runId);
	try {
		await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({ opencode: { type: "api_key", key: apiKey } })}\n`);

		for (const task of tasks) {
			for (let repetition = 1; repetition <= options.reps; repetition += 1) {
				for (const arm of arms) {
					console.error(`[benchmark] ${task.id} rep=${repetition} arm=${arm}`);
					results.push(
						await runTreatment({
							name: arm,
							repository,
							task,
							repetition,
							runRoot,
							requiredExtensions: [isolationSupportPath],
							agentDir,
							sessionDir: join(runRoot, `session-${arm}`),
							model: options.model,
							thinking: options.thinking,
							timeoutMs: 600_000,
							interventionEnabled: false,
							gateEnabled: false,
							promptAppend: arm === "improved" ? SPEC_VERIFICATION_APPEND : null,
						}),
					);
					const r = results.at(-1);
					console.error(
						`[benchmark] solved=${r.solved} tests=${r.verifier.tests ?? "?"} noise=${r.providerNoise} sig=${JSON.stringify(r.completionSignature)}`,
					);
				}
			}
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}

	// Run-manifest provenance (AGENTS Evaluation Evidence): source, build,
	// evaluator/provider, task revision, environment.
	const provenance = {
		baseline: {
			repository,
			commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository }).toString().trim(),
			launcher: join(repository, "pi-test.sh"),
		},
		modelIdentity:
			"opencode/x-preview-f-free per pi's opencode catalog (openai-completions, https://opencode.ai/zen); " +
			"user-declared 'Ox Alpha Free from OpenCode Zen'; this session's harness reports opencode-zen/x-preview-f-free " +
			"as the serving model for ox-alpha. Zen catalog listing returned 403 (model-scoped key), so identity rests on " +
			"the session harness string + catalog entry, not a live catalog query.",
		evaluator: {
			verifiers: tasks.map((t) => ({
				task: t.id,
				path: t.verifier,
				sha256: hashFile(resolve(packageRoot, "diagnostics", t.verifier)),
			})),
			tasks: tasks.map((t) => ({
				id: t.id,
				fixture: t.fixture,
				hash: hashTree(resolve(packageRoot, "diagnostics", t.fixture)),
			})),
			intervention: options.arm === "both" ? "spec-verification-append (preregistered 2026-08-24)" : "none",
		},
		environment: {
			node: process.version,
			platform: `${process.platform}/${process.arch}`,
			isolation: "pi-test.sh --no-env strips ambient API keys; model key in temp agent-dir auth.json (removed post-run)",
			extensions: [isolationSupportPath],
		},
	};
	const summary = {
		schemaVersion: 1,
		kind: "benchmark",
		runId,
		model: options.model,
		thinking: options.thinking,
		arms,
		tasks: tasks.map((t) => t.id),
		repetitions: options.reps,
		provenance,
		results,
	};
	await writeFile(join(runRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	console.log(JSON.stringify(summary, null, 2));
}

main();
