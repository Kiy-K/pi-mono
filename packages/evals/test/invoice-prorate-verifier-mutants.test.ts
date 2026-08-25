import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/invoice-prorate.py.
 *
 * The verifier must reject allocators that violate SPEC's largest-remainder
 * rules: exact-cent conservation, tie-breaking by insertion order, strict
 * integer/bool payment validation, range validation, and invoice immutability.
 * The bundled suite only covers clean divisions, so every mutant here passes
 * the bundled tests by construction - only the named checks catch them.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "invoice-prorate");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "invoice-prorate.py");

const REFERENCE = `"""Payment allocation per SPEC.md."""

from invoice import Invoice


class PaymentError(ValueError):
    """Raised for invalid payments."""


def allocate_payment(invoice: Invoice, payment_cents: int) -> list[int]:
    if isinstance(payment_cents, bool) or not isinstance(payment_cents, int):
        raise PaymentError("payment must be an integer number of cents")
    total = invoice.total_cents()
    if payment_cents < 0 or payment_cents > total:
        raise PaymentError("payment out of range")
    lines = invoice.lines()
    bases = []
    fracs = []
    for line in lines:
        numer = payment_cents * line.amount_cents
        bases.append(numer // total)
        fracs.append(numer % total)
    leftover = payment_cents - sum(bases)
    order = sorted(range(len(lines)), key=lambda i: (-fracs[i], i))
    allocation = list(bases)
    for index in order[:leftover]:
        allocation[index] += 1
    return allocation
`;

/** name -> [anchor, replacement]: one plausible wrong allocation rule. */
const MUTANTS: Record<string, readonly [string, string]> = {
	// Float division + round() instead of exact integer largest-remainder.
	float_round: [
		"        bases.append(numer // total)\n        fracs.append(numer % total)",
		"        import math\n        bases.append(round(numer / total))\n        fracs.append(0)",
	],
	// Drops leftover cents (violates exact conservation).
	leftover_dropped: ["    for index in order[:leftover]:\n        allocation[index] += 1", ""],
	// Fractional ties broken by highest index instead of insertion order.
	tie_last_line: ["key=lambda i: (-fracs[i], i)", "key=lambda i: (-fracs[i], -i)"],
	// Accepts floats such as 100.0 (SPEC: rejected).
	float_accepted: ["if isinstance(payment_cents, bool) or not isinstance(payment_cents, int):", "if False:"],
	// bool treated as int 1 (SPEC: bool rejected).
	bool_accepted: [
		"if isinstance(payment_cents, bool) or not isinstance(payment_cents, int):",
		"if not isinstance(payment_cents, int):",
	],
	// No range validation.
	range_check_dropped: [
		'    if payment_cents < 0 or payment_cents > total:\n        raise PaymentError("payment out of range")',
		"",
	],
	// Zero payment reported as an empty allocation (SPEC: list of zeros).
	zero_payment_returns_empty: [
		"    lines = invoice.lines()",
		"    if payment_cents == 0:\n        return []\n    lines = invoice.lines()",
	],
	// PaymentError not a ValueError (breaks `except ValueError` callers).
	error_not_value_error: ["class PaymentError(ValueError):", "class PaymentError(Exception):"],
	// Reverses the working order, changing allocation results.
	invoice_reordered: ["    lines = invoice.lines()", "    lines = list(reversed(invoice.lines()))"],
	// Consumes invoice lines while allocating (mutates the invoice).
	consumes_invoice_lines: [
		"    lines = invoice.lines()",
		"    lines = [invoice._lines.pop(key) for key in list(invoice._lines)]",
	],
};

/** The named checks each mutant is expected to be caught by. */
const EXPECTED_CHECKS: Record<string, readonly string[]> = {
	float_round: ["remainder ties break by line order", "payment conserved exactly on remainder-heavy cases"],
	leftover_dropped: [
		"leftover cents go to largest fractional remainder",
		"payment conserved exactly on remainder-heavy cases",
	],
	tie_last_line: ["leftover cents go to largest fractional remainder", "remainder ties break by line order"],
	float_accepted: ["non-integer payment rejected with message"],
	bool_accepted: ["non-integer payment rejected with message"],
	range_check_dropped: [
		"negative payment rejected",
		"payment above total rejected",
		"empty invoice accepts only zero payment",
	],
	zero_payment_returns_empty: ["zero payment allocates zeros"],
	error_not_value_error: ["PaymentError subclasses ValueError"],
	invoice_reordered: ["clean proportional split"],
	consumes_invoice_lines: ["allocation does not mutate the invoice"],
};

function applyMutation(source: string, [find, replace]: readonly [string, string]): string {
	if (!source.includes(find)) throw new Error(`Mutant anchor not found: ${find.slice(0, 60)}...`);
	return source.replace(find, replace);
}

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(prorateSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-invoice-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "invoice.py"), join(root, "invoice.py")),
			copyFile(join(fixtureRoot, "test_prorate.py"), join(root, "test_prorate.py")),
			writeFile(join(root, "prorate.py"), prorateSource),
		]);
		// The verifier exits non-zero when checks fail; a caught mutant is an
		// expected rejection, so parse stdout instead of treating exit 1 as error.
		// Purge __pycache__: importlib caches .pyc by mtime+size and same-size
		// mutants written quickly could otherwise validate stale bytecode.
		await rm(join(root, "__pycache__"), { recursive: true, force: true });
		const { stdout } = await execFileAsync(
			process.platform === "win32" ? "python" : "python3",
			[verifierPath, root],
			{ timeout: 30_000 },
		).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
		const payload = JSON.parse(stdout.trim()) as VerifierResult;
		return Array.isArray(payload?.failures) ? payload : { passed: false, tests: 0, failures: [stdout] };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function namedChecks(result: VerifierResult): string[] {
	const names: string[] = [];
	for (const failure of result.failures) {
		if (!failure.startsWith("test_prorate.")) names.push(failure.split(":")[0]);
	}
	return [...new Set(names)];
}

describe("invoice-prorate verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, mutation] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(applyMutation(REFERENCE, mutation));
			expect(result.passed).toBe(false);
			for (const checkName of EXPECTED_CHECKS[name]) {
				expect(namedChecks(result), `${name} must be caught by '${checkName}'`).toContain(checkName);
			}
		});
	}

	it("every named check attributes at least one mutant (no dead checks)", () => {
		const covered = new Set(Object.values(EXPECTED_CHECKS).flat());
		const allChecks = [
			"clean proportional split",
			"leftover cents go to largest fractional remainder",
			"remainder ties break by line order",
			"payment conserved exactly on remainder-heavy cases",
			"zero payment allocates zeros",
			"negative payment rejected",
			"payment above total rejected",
			"non-integer payment rejected with message",
			"empty invoice accepts only zero payment",
			"PaymentError subclasses ValueError",
			"allocation does not mutate the invoice",
		];
		for (const checkName of allChecks) {
			expect(covered, `'${checkName}' must attribute at least one mutant`).toContain(checkName);
		}
	});
});
