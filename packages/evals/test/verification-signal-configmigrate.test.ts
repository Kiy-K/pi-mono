import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, MIGRATE_REF, MUTANTS } from "./configmigrate-mutants.ts";

/**
 * Verification-signal characterization for the config-migrate development
 * fixture: does the bundled public test suite (the only in-loop verification
 * signal the agent sees when told to "run the available tests") catch each
 * SPEC-violating mutant? A mutant that passes the public suite but fails the
 * external verifier is an in-loop blind spot: an agent can run the tests, see
 * green, and stop - apparent completion with corrective work remaining,
 * invisible to ordering-based completion signatures.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "config-migrate");

async function runPublicSuite(migrateSource: string): Promise<{ passed: boolean; output: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifsignal-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_migrate.py"), join(root, "test_migrate.py")),
			writeFile(join(root, "migrate.py"), migrateSource),
		]);
		await rm(join(root, "__pycache__"), { recursive: true, force: true });
		// Success/failure comes ONLY from the unittest exit status: output text
		// is unreliable (unittest reports to stderr; stdout can be empty on
		// import/discovery collapse).
		const { stdout, stderr } = await execFileAsync(
			process.platform === "win32" ? "python" : "python3",
			["-m", "unittest", "discover", "-v"],
			{ cwd: root, timeout: 30_000 },
		);
		return { passed: true, output: `${stdout}${stderr}` };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return { passed: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("config-migrate in-loop verification signal", () => {
	it("passes the bundled public suite on the SPEC-faithful reference", async () => {
		const result = await runPublicSuite(MIGRATE_REF);
		// Guard against silent discovery collapse: all 4 bundled tests must run.
		expect(result.output, result.output).toContain("Ran 4 tests");
		expect(result.output, result.output).toContain("OK");
		expect(result.passed, result.output).toBe(true);
	});

	it("classifies a crashing (syntax-error) mutant as caught, not as a blind spot", async () => {
		const result = await runPublicSuite("def broken(:\n");
		expect(result.passed, result.output).toBe(false);
	});

	/**
	 * Pinned blind-spot set (measured 2026-08-24): 4 of 11 SPEC-violating
	 * mutants pass the bundled public test_migrate.py. The SPEC directs the
	 * agent to implement rules "even where test_migrate.py does not check
	 * them", so this is the fixture's designed difficulty - but it means
	 * "ran the bundled tests and saw green" is NOT evidence of external
	 * correctness on this task. These are in-loop-invisible SPEC rules.
	 */
	const BLIND_SPOTS: Record<string, true> = {
		bool_port_counted_as_coerced: true,
		missing_reference_still_counted: true,
		string_port_counted_as_coerced: true,
		version_only_added_when_absent: true,
	};

	it("classifies every mutant as caught or missed by the public suite", async () => {
		const blind: string[] = [];
		for (const [name, mutation] of Object.entries(MUTANTS)) {
			const result = await runPublicSuite(applyMutation(mutation));
			if (result.passed) blind.push(name);
		}
		expect(blind.slice().sort()).toEqual(Object.keys(BLIND_SPOTS).sort());
	});
});
