import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/cart-promotions.py.
 *
 * Audit history: the verifier originally only tested bogo's x parameter, so a
 * mutant accepting y = 0 / negative y (SPEC requires the same
 * "x and y must be >= 1" error for both) survived every check and the public
 * suite. The named check 'bogo y=0 and negative y rejected' was added; this
 * suite pins the SPEC-faithful references and the violating mutants so the
 * hole cannot reopen.
 */

const execFileAsync = promisify(execFile);

import { applyMutation, MUTANTS, PROMO_REF, RECEIPT_REF } from "./cartpromotions-mutants.ts";

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "cart-promotions");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "cart-promotions.py");

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(promoSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-cartpromos-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_cart.py"), join(root, "test_cart.py")),
			copyFile(join(fixtureRoot, "test_promotions.py"), join(root, "test_promotions.py")),
			copyFile(join(fixtureRoot, "cart.py"), join(root, "cart.py")),
			writeFile(join(root, "promotions.py"), promoSource),
			writeFile(join(root, "receipt.py"), RECEIPT_REF),
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

describe("cart-promotions verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(PROMO_REF);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, mutation] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(applyMutation(mutation));
			expect(result.passed).toBe(false);
			expect(result.failures.length).toBeGreaterThan(0);
			if (!["bogo_remainder_discounted"].includes(name)) {
				// remainder mutant is attributed by the named check directly;
				// require every mutant to be caught by at least one named check.
				const named = result.failures.filter((f) => !f.startsWith("test_")).length;
				expect(named, `${name} must be caught by a named check`).toBeGreaterThan(0);
			}
		});
	}
});
