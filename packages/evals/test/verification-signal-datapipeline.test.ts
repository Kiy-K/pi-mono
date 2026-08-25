import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, MUTANTS, REFERENCE } from "./datapipeline-mutants.ts";

/**
 * Verification-signal characterization for the data-pipeline development
 * fixture: does the bundled public test suite (the only in-loop verification
 * signal the agent sees when told to "run the available tests") catch each
 * SPEC-violating mutant? A mutant that passes the public suite but fails the
 * external verifier is an in-loop blind spot: an agent can run the tests, see
 * green, and stop - apparent completion with corrective work remaining,
 * invisible to ordering-based completion signatures.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "data-pipeline");

async function runPublicSuite(sources: Record<string, string>): Promise<{ passed: boolean; output: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifsignal-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_pipeline.py"), join(root, "test_pipeline.py")),
			writeFile(join(root, "parser.py"), sources["parser.py"]),
			writeFile(join(root, "validator.py"), sources["validator.py"]),
			writeFile(join(root, "transformer.py"), sources["transformer.py"]),
			writeFile(join(root, "pipeline.py"), sources["pipeline.py"]),
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

describe("data-pipeline in-loop verification signal", () => {
	it("passes the bundled public suite on the SPEC-faithful reference", async () => {
		const result = await runPublicSuite(REFERENCE);
		// Guard against silent discovery collapse: all 18 bundled tests must run.
		expect(result.output, result.output).toContain("Ran 18 tests");
		expect(result.output, result.output).toContain("OK");
		expect(result.passed, result.output).toBe(true);
	});

	it("classifies a crashing (syntax-error) mutant as caught, not as a blind spot", async () => {
		const result = await runPublicSuite({ ...REFERENCE, "parser.py": "def broken(:\n" });
		expect(result.passed, result.output).toBe(false);
	});

	/**
	 * Pinned blind-spot set (measured 2026-08-24): 7 of 14 SPEC-violating
	 * mutants pass the bundled public suite - the tests never exercise the
	 * rules they break (comment/hashes handling in the parser, name/age
	 * validation edges, the >= 18 transform filter), so "ran the bundled
	 * tests and saw green" is NOT evidence of external correctness on this
	 * task. These are in-loop-invisible SPEC rules; only the external
	 * verifier observes them.
	 */
	const BLIND_SPOTS: Record<string, true> = {
		comment_rule_removed: true,
		empty_name_accepted: true,
		filter_excludes_18: true,
		hash_anywhere_starts_comment: true,
		missing_age_defaults_zero: true,
		negative_age_accepted: true,
		splits_on_last_equals: true,
	};

	it("classifies every mutant as caught or missed by the public suite", async () => {
		const blind: string[] = [];
		for (const [name, [moduleName, find, replace]] of Object.entries(MUTANTS)) {
			const result = await runPublicSuite({
				...REFERENCE,
				[moduleName]: applyMutation(moduleName, [find, replace]),
			});
			if (result.passed) blind.push(name);
		}
		expect(blind.slice().sort()).toEqual(Object.keys(BLIND_SPOTS).sort());
	});
});
