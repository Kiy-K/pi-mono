import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, MUTANTS, MIGRATE_REF as REFERENCE } from "./configmigrate-mutants.ts";

/**
 * Mutant attribution for diagnostics/verifiers/config-migrate.py.
 *
 * Audit history: the verifier originally never fed a pre-existing `version`
 * field or a non-int `port` (string/bool) through migrate, so mutants
 * violating SPEC rule 4's overwrite semantics and rule 2's integer-only type
 * boundary passed every check and the public suite. Two checks were added;
 * this suite pins the reference implementation and the violating mutants so
 * those holes cannot reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "config-migrate");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "config-migrate.py");

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(migrateSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-configmigrate-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_migrate.py"), join(root, "test_migrate.py")),
			writeFile(join(root, "migrate.py"), migrateSource),
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
				.filter((failure) => !failure.startsWith("test_migrate."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("config-migrate verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, mutation] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(applyMutation(mutation));
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_migrate.")).length,
			).toBeGreaterThan(0);
			if (name !== "version_never_added") {
				// version_never_added is attributed by the public suite alone;
				// every other mutant must be caught by a named verifier check.
				expect(namedChecks(result), `${name} must be caught by a named check`).not.toEqual([]);
			}
		});
	}
});
