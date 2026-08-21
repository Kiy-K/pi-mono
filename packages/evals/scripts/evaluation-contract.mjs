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

/**
 * Computes the SHA-256 digest of a value.
 * @param {string|Buffer} value - The value to hash.
 * @return {string} The digest encoded as a hexadecimal string.
 */
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Determines whether a value is a nonempty string after trimming whitespace.
 * @param {*} value - The value to check.
 * @return {boolean} `true` if the value is a nonempty string, `false` otherwise.
 */
function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Serializes a value as a JSON string.
 * @param {*} value - The value to serialize.
 * @return {string|undefined} The JSON representation of the value, or `undefined` when it cannot be represented in JSON.
 */
function compareValue(value) {
	return JSON.stringify(value);
}

/**
 * Classifies a trial result based on cancellation, errors, timeout, and verification status.
 * @param {Object} input - Trial execution and verification details.
 * @returns {string} The outcome label: `"cancelled_user"`, `"invalid_provider"`, `"invalid_infra"`, `"timeout_harness"`, `"solved"`, or `"unsolved"`.
 */
export function classifyOutcome(input) {
	if (input.cancelled === true) return "cancelled_user";
	if (nonEmptyString(input.providerError)) return "invalid_provider";
	if (nonEmptyString(input.infrastructureError)) return "invalid_infra";
	if (input.processTimedOut === true) return "timeout_harness";
	if (input.processExitedCleanly === true && input.verifierPassed === true) return "solved";
	return "unsolved";
}

/**
 * Verifies that stock and candidate trials have matching identity fields and nonempty artifact hashes.
 * @param {Object} stock - The stock trial to validate.
 * @param {Object} candidate - The candidate trial to validate.
 * @throws {Error} If a required identity field is missing or mismatched, or either artifact hash is empty.
 */
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

/**
 * Creates a schema-versioned manifest describing comparable stock and candidate trial runs.
 * @param {Object} options - Manifest inputs.
 * @param {string} options.runId - Identifier for the evaluation run.
 * @param {Object} options.stock - Stock trial metadata.
 * @param {Object} options.candidate - Candidate trial metadata.
 * @param {string[]} options.runOrder - Order in which the stock and candidate trials ran.
 * @param {string} options.outcome - Classified outcome of the evaluation.
 * @returns {Object} The completed run manifest.
 * @throws {Error} If the run ID, trial metadata, or run order is invalid.
 */
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

/**
 * Loads and validates an evaluator descriptor.
 * @param {string|URL} path - The path or file URL of the evaluator descriptor.
 * @return {Promise<Object>} The evaluator descriptor with its resolved path, SHA-256 hash, blocked status, and missing required fields.
 * @throws {Error} If the descriptor cannot be read, parsed, or does not use the required schema, provider, model, or thinking level.
 */
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

/**
 * Computes the SHA-256 hash of a file.
 * @param {string} path - The path to the file.
 * @return {Promise<string>} The file's SHA-256 hash.
 */
async function fileSha256(path) {
	return sha256(await readFile(path));
}

/**
 * Validates an evaluator descriptor and its referenced files for execution.
 * @param {string} path - Path to the evaluator descriptor.
 * @returns {{status: "ready", evaluator: Object}|{status: "blocked", reason: string}} The preflight result, including evaluator metadata when ready or a blocking reason otherwise.
 */
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

/**
 * Runs the evaluator preflight command and prints its result as JSON.
 * @param {string[]} args - Command-line arguments containing `preflight --evaluator <path>`.
 * @throws {Error} If the required command-line arguments are missing or invalid.
 */
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
