import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_IDENTITY_KEYS = [
	"sourceAnchor",
	"evaluatorSha256",
	"configSha256",
	"provider",
	"model",
	"thinking",
	"taskRevision",
	"prompt",
	"tools",
	"timeoutMs",
];

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

function compareValue(value) {
	return JSON.stringify(value);
}

export function classifyOutcome(input) {
	if (input.cancelled === true) return "cancelled_user";
	if (nonEmptyString(input.providerError)) return "invalid_provider";
	if (nonEmptyString(input.infrastructureError)) return "invalid_infra";
	if (input.processTimedOut === true) return "timeout_harness";
	if (input.processExitedCleanly === true && input.verifierPassed === true) return "solved";
	return "unsolved";
}

export function assertComparableTrials(stock, candidate) {
	for (const key of REQUIRED_IDENTITY_KEYS) {
		if (!(key in stock) || !(key in candidate)) throw new Error(`Missing comparable treatment field: ${key}.`);
		if (compareValue(stock[key]) !== compareValue(candidate[key])) {
			throw new Error(`Stock/candidate mismatch for ${key}.`);
		}
	}
	if (!nonEmptyString(stock.artifactSha256) || !nonEmptyString(candidate.artifactSha256)) {
		throw new Error("Stock and candidate require artifactSha256.");
	}
}

export function makeRunManifest({ runId, stock, candidate, runOrder, outcome }) {
	if (!nonEmptyString(runId)) throw new Error("Run manifest requires runId.");
	assertComparableTrials(stock, candidate);
	if (!Array.isArray(runOrder) || runOrder.some((name) => name !== "stock" && name !== "candidate")) {
		throw new Error("Run manifest requires stock/candidate runOrder.");
	}
	return {
		schemaVersion: 2,
		runId,
		sourceAnchor: stock.sourceAnchor,
		stock: { artifactSha256: stock.artifactSha256 },
		candidate: { artifactSha256: candidate.artifactSha256 },
		evaluator: {
			provider: stock.provider,
			model: stock.model,
			thinking: stock.thinking,
			artifactSha256: stock.evaluatorSha256,
			configSha256: stock.configSha256,
		},
		task: {
			revision: stock.taskRevision,
			prompt: stock.prompt,
			tools: stock.tools,
			timeoutMs: stock.timeoutMs,
		},
		runOrder,
		outcome,
	};
}

export async function readEvaluatorContract(path) {
	const descriptorPath = path instanceof URL ? fileURLToPath(path) : path;
	const source = await readFile(descriptorPath, "utf8");
	const evaluator = JSON.parse(source);
	if (evaluator?.schemaVersion !== 1) throw new Error("Evaluator descriptor must have schemaVersion 1.");
	if (evaluator.provider !== "clinepass" || evaluator.model !== "deepseek-v4-flash" || evaluator.thinking !== "medium") {
		throw new Error("Evaluator descriptor must pin clinepass/deepseek-v4-flash at medium thinking.");
	}
	const required = ["extensionPath", "extensionSha256", "configSha256", "headlessCommand"];
	const missing = required.filter((key) => !nonEmptyString(evaluator[key]));
	return {
		...evaluator,
		path: resolve(descriptorPath),
		descriptorSha256: sha256(source),
		blocked: missing.length > 0,
		missing,
	};
}

async function fileSha256(path) {
	return sha256(await readFile(path));
}

export async function preflightEvaluator(path) {
	const evaluator = await readEvaluatorContract(path);
	if (evaluator.blocked) {
		return { status: "blocked", reason: `Evaluator descriptor is missing: ${evaluator.missing.join(", ")}.` };
	}
	try {
		await access(evaluator.extensionPath, constants.R_OK);
		const extensionSha256 = await fileSha256(evaluator.extensionPath);
		if (extensionSha256 !== evaluator.extensionSha256) {
			return { status: "blocked", reason: "Evaluator extension SHA-256 does not match descriptor." };
		}
		await access(evaluator.headlessCommand, constants.X_OK);
		return { status: "ready", evaluator: { ...evaluator, extensionPath: undefined, headlessCommand: undefined } };
	} catch (error) {
		return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
	}
}

async function main(args) {
	if (args[0] !== "preflight" || args[1] !== "--evaluator" || !args[2]) {
		throw new Error("Usage: evaluation-contract.mjs preflight --evaluator <path>.");
	}
	console.log(JSON.stringify(await preflightEvaluator(args[2])));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
