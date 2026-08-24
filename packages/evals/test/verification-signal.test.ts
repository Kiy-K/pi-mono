import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyMutation, MUTANTS, PROMO_REF, RECEIPT_REF } from "./cartpromotions-mutants.ts";

/**
 * Verification-signal characterization for the cart-promotions development
 * fixture: does the bundled public test suite (the only in-loop verification
 * signal the agent sees when told to "run the available tests") catch each
 * SPEC-violating mutant? A mutant that passes the public suite but fails the
 * external verifier is an in-loop blind spot: an agent can run the tests, see
 * green, and stop - apparent completion with corrective work remaining,
 * invisible to ordering-based completion signatures.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "cart-promotions");

async function runPublicSuite(promoSource: string): Promise<{ passed: boolean; output: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifsignal-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_cart.py"), join(root, "test_cart.py")),
			copyFile(join(fixtureRoot, "test_promotions.py"), join(root, "test_promotions.py")),
			copyFile(join(fixtureRoot, "cart.py"), join(root, "cart.py")),
			writeFile(join(root, "promotions.py"), promoSource),
			writeFile(join(root, "receipt.py"), RECEIPT_REF),
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

describe("cart-promotions in-loop verification signal", () => {
	it("passes the bundled public suite on the SPEC-faithful reference", async () => {
		const result = await runPublicSuite(PROMO_REF);
		// Guard against silent discovery collapse: all 9 bundled tests must run.
		expect(result.output, result.output).toContain("Ran 9 tests");
		expect(result.output, result.output).toContain("OK");
		expect(result.passed, result.output).toBe(true);
	});

	it("classifies a crashing (syntax-error) mutant as caught, not as a blind spot", async () => {
		const result = await runPublicSuite("def broken(:\n");
		expect(result.passed, result.output).toBe(false);
	});

	/**
	 * Pinned blind-spot set (measured 2026-08-24): 14 of 18 SPEC-violating
	 * mutants pass the bundled public suite. The SPEC directs the agent to
	 * implement error cases "even where test_promotions.py does not check
	 * them", so this is the fixture's designed difficulty - but it means
	 * "ran the bundled tests and saw green" is NOT evidence of external
	 * correctness on this task, and reps ending in that state are the
	 * premature-completion class the completionSignature telemetry must
	 * attribute by reading the verifier result, not the command history.
	 */
	const BLIND_SPOTS: Record<string, true> = {
		rounds_once_per_cart: true,
		bogo_remainder_discounted: true,
		bogo_y_unvalidated: true,
		bogo_y_lt1_unvalidated: true,
		discount_cap_missing: true,
		str_percent_coerced: true,
		none_percent_skips_discount: true,
		percent_over_100_accepted: true,
		float_percent_rejected: true,
		unknown_sku_discounts_first_line: true,
		bogo_x_unvalidated: true,
		exclusivity_dropped: true,
		error_not_value_error: true,
		empty_promotions_nonzero_total: true,
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
