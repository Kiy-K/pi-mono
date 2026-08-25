import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, EQUIVALENT_MUTANTS, MUTANTS, REFERENCE } from "./datapipeline-mutants.ts";

/**
 * Mutant attribution for diagnostics/verifiers/data-pipeline.py.
 *
 * Audit history: the verifier originally never fed an exactly-18 record
 * through transformer.transform (SPEC boundary int(age) >= 18 unobserved),
 * never distinguished leading-# comments from hashes inside values, and never
 * rejected records with an empty or missing name/age key. Four checks were
 * added; this suite pins the reference implementation and the violating
 * mutants so those holes cannot reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "data-pipeline");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "data-pipeline.py");

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(sources: Record<string, string>): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-datapipeline-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_pipeline.py"), join(root, "test_pipeline.py")),
			writeFile(join(root, "parser.py"), sources["parser.py"]),
			writeFile(join(root, "validator.py"), sources["validator.py"]),
			writeFile(join(root, "transformer.py"), sources["transformer.py"]),
			writeFile(join(root, "pipeline.py"), sources["pipeline.py"]),
		]);
		// Purge __pycache__: importlib caches .pyc by mtime+size and same-size
		// mutants written quickly could otherwise validate stale bytecode.
		await rm(join(root, "__pycache__"), { recursive: true, force: true });
		// The verifier exits non-zero when checks fail; a caught mutant is an
		// expected rejection, so parse stdout instead of treating exit 1 as error.
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "python" : "python3",
			[verifierPath, root],
			{
				timeout: 30_000,
			},
		).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
		const payload = JSON.parse(stdout.trim()) as VerifierResult;
		return Array.isArray(payload?.failures) ? payload : { passed: false, tests: 0, failures: [stdout] };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function namedChecks(result: VerifierResult): string[] {
	return [
		...new Set(
			result.failures
				.filter((failure) => !failure.startsWith("test_pipeline."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("data-pipeline verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, [moduleName, find, replace]] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier({ ...REFERENCE, [moduleName]: applyMutation(moduleName, [find, replace]) });
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_pipeline.")).length,
			).toBeGreaterThan(0);
			if (!["malformed_line_parsed", "admin_age_rule_dropped", "guest_role_rejected"].includes(name)) {
				// These are attributed by the public suite alone; every other
				// mutant must be caught by at least one named verifier check.
				expect(namedChecks(result), `${name} must be caught by a named check`).not.toEqual([]);
			}
		});
	}
	for (const [name, [moduleName, find, replace]] of Object.entries(EQUIVALENT_MUTANTS)) {
		it(`ignores the ${name} mutant (equivalent under the SPEC API)`, async () => {
			const result = await runVerifier({ ...REFERENCE, [moduleName]: applyMutation(moduleName, [find, replace]) });
			expect(result.passed).toBe(true);
		});
	}
});
