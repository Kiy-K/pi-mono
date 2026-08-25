import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MUTANTS, REFERENCE } from "./matchingengine-mutants.ts";

/**
 * Verification-signal characterization for the matching-engine development
 * fixture: does the bundled public test suite (the only in-loop verification
 * signal the agent sees when told to "run the available tests") catch each
 * SPEC-violating mutant? A mutant that passes the public suite but fails the
 * external verifier is an in-loop blind spot: an agent can run the tests, see
 * green, and stop - apparent completion with corrective work remaining,
 * invisible to ordering-based completion signatures.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "matching-engine");

async function runPublicSuite(sources: Record<string, string>): Promise<{ passed: boolean; output: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifsignal-me-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_engine.py"), join(root, "test_engine.py")),
			...Object.entries(sources).map(([filename, source]) => writeFile(join(root, filename), source)),
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

describe("matching-engine in-loop verification signal", () => {
	it("passes the bundled public suite on the SPEC-faithful reference", async () => {
		const result = await runPublicSuite({ "engine.py": REFERENCE });
		// Guard against silent discovery collapse: all 8 bundled tests must run.
		expect(result.output, result.output).toContain("Ran 8 tests");
		expect(result.output, result.output).toContain("OK");
		expect(result.passed, result.output).toBe(true);
	});

	it("classifies a crashing (syntax-error) mutant as caught, not as a blind spot", async () => {
		const result = await runPublicSuite({ "engine.py": "def broken(:\n" });
		expect(result.passed, result.output).toBe(false);
	});

	/**
	 * Pinned blind-spot set (measured 2026-08-24): 3 of 9 SPEC-violating
	 * mutants pass the bundled public suite. These are in-loop-invisible
	 * SPEC rules - the public tests never exercise equal-price FIFO on the
	 * resting-sell side, best-bid ordering in `book()`, or the exact
	 * bound-validation message - so "ran the bundled tests and saw green" is
	 * NOT evidence of external correctness on this task, and reps ending in
	 * that state are the premature-completion class the completionSignature
	 * telemetry must attribute by reading the verifier result, not the
	 * command history.
	 */
	const BLIND_SPOTS: Record<string, true> = {
		buy_book_sorted_ascending: true,
		sell_side_fifo_inverted: true,
		wrong_bound_message: true,
	};
	it("classifies every mutant as caught or missed by the public suite", async () => {
		const blind: string[] = [];
		for (const [name, build] of Object.entries(MUTANTS)) {
			const result = await runPublicSuite({ "engine.py": build() });
			if (result.passed) blind.push(name);
		}
		expect(blind.slice().sort()).toEqual(Object.keys(BLIND_SPOTS).sort());
	});
});
