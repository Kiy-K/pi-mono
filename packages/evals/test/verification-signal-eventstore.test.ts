import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, MUTANTS, REFERENCE } from "./eventstore-mutants.ts";

/**
 * Verification-signal characterization for the event-store fixture: does the
 * bundled public test suite (the only in-loop verification signal the agent
 * sees when told to "run the available tests") catch each SPEC-violating
 * mutant? A mutant that passes the public suite but fails the external
 * verifier is an in-loop blind spot: an agent can run the tests, see green,
 * and stop - apparent completion with corrective work remaining.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "event-store");

const BUNDLED_TEST_COUNT = 9;

async function runPublicSuite(storeSource: string): Promise<{ passed: boolean; output: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifsignal-es-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_store.py"), join(root, "test_store.py")),
			writeFile(join(root, "store.py"), storeSource),
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

describe("event-store in-loop verification signal", () => {
	it("passes the bundled public suite on the SPEC-faithful reference", async () => {
		const result = await runPublicSuite(REFERENCE);
		// Guard against silent discovery collapse: all bundled tests must run.
		expect(result.output, result.output).toContain(`Ran ${BUNDLED_TEST_COUNT} tests`);
		expect(result.output, result.output).toContain("OK");
		expect(result.passed, result.output).toBe(true);
	});

	it("classifies a crashing (syntax-error) mutant as caught, not as a blind spot", async () => {
		const result = await runPublicSuite("def broken(:\n");
		expect(result.passed, result.output).toBe(false);
	});

	/**
	 * Pinned blind-spot set (measured 2026-08-24): mutants that pass the
	 * bundled public suite. The SPEC makes behavior beyond the bundled tests
	 * normative, so these are in-loop-invisible SPEC rules: an agent can run
	 * the tests, see green, and stop while failing the external verifier.
	 */
	const BLIND_SPOTS: Record<string, true> = {
		int_value_loaded: true,
		malformed_json_raises: true,
		null_value_loaded: true,
		type_checks_removed: true,
	};

	it("classifies every mutant as caught or missed by the public suite", async () => {
		const blind: string[] = [];
		for (const [name, mutation] of Object.entries(MUTANTS)) {
			const result = await runPublicSuite(applyMutation(REFERENCE, mutation));
			if (result.passed) blind.push(name);
		}
		expect(blind.slice().sort()).toEqual(Object.keys(BLIND_SPOTS).sort());
	});
});
