import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MUTANTS, REFERENCE } from "./matchingengine-mutants.ts";

/**
 * Mutant attribution for diagnostics/verifiers/matching-engine.py.
 *
 * Audit history: the verifier originally had no same-price FIFO scenario at
 * all — a matching-order time-priority inversion survived every check and the
 * public suite when only equal-price resting SELLS were involved (the lone
 * public FIFO test rested two buys). The named check 'same-price orders fill
 * in arrival order on both sides' was added; this suite pins the reference
 * implementation and the side-specific inversion mutants so the hole cannot
 * reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "matching-engine");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "matching-engine.py");

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(engineSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-matchingengine-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_engine.py"), join(root, "test_engine.py")),
			writeFile(join(root, "engine.py"), engineSource),
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
				.filter((failure) => !failure.startsWith("test_engine."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("matching-engine verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it.each([["sell_side_fifo_inverted"], ["buy_side_fifo_inverted"]])(
		`catches %s via the both-sides FIFO check`,
		async (name) => {
			const result = await runVerifier(MUTANTS[name]());
			expect(result.passed).toBe(false);
			expect(namedChecks(result), `${name} must be caught by the FIFO check`).toContain(
				"same-price orders fill in arrival order on both sides",
			);
		},
	);

	for (const [name, build] of Object.entries(MUTANTS)) {
		if (name.endsWith("fifo_inverted")) continue;
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(build());
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_engine.")).length,
			).toBeGreaterThan(0);
		});
	}
});
