import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/log-rotate-v2.py.
 *
 * Acceptance-criteria guard: a diagnostic verifier is valid only when its
 * checks actually execute (no dead checks) and deliberately faulty mutants
 * are rejected by named checks. The SPEC-faithful reference below must pass
 * all checks; every mutant must be caught by at least one named check
 * (failures prefixed with the check name, not "test_rotation.").
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "log-rotate-v2");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "log-rotate-v2.py");

const REFERENCE = `"""Reference implementation derived solely from log-rotate-v2 SPEC.md."""

import os
from pathlib import Path

from journal import Journal


class RotationError(ValueError):
    """Raised for invalid rotation parameters."""


def should_rotate(path: str, max_bytes: int) -> bool:
    if not isinstance(max_bytes, int) or max_bytes < 1:
        raise RotationError("max_bytes must be >= 1")
    p = Path(path)
    if not p.is_file():
        return False
    return p.stat().st_size >= max_bytes


def rotate(path: str, keep: int) -> list[str]:
    if not isinstance(keep, int) or keep < 1:
        raise RotationError("keep must be >= 1")
    base = Path(path)
    for i in range(keep - 1, 0, -1):
        src = base.with_name(base.name + f".{i}")
        dst = base.with_name(base.name + f".{i + 1}")
        if src.exists():
            os.replace(src, dst)
    for entry in base.parent.iterdir():
        if not entry.name.startswith(base.name + "."):
            continue
        suffix = entry.name[len(base.name) + 1 :]
        if not suffix.isdigit():
            continue
        if int(suffix) > keep:
            entry.unlink()
    existed = base.exists()
    rotated: list[str] = []
    if existed:
        os.replace(base, base.with_name(base.name + ".1"))
    for i in range(1, keep + 1):
        slot = base.with_name(base.name + f".{i}")
        if slot.exists():
            rotated.append(slot.name)
    return rotated


def append_with_rotation(journal: Journal, entry: dict, max_bytes: int, keep: int) -> list[str]:
    if not isinstance(max_bytes, int) or max_bytes < 1:
        raise RotationError("max_bytes must be >= 1")
    if not isinstance(keep, int) or keep < 1:
        raise RotationError("keep must be >= 1")
    rotated: list[str] = []
    if journal.size_bytes() >= max_bytes:
        rotated = rotate(journal.path.as_posix(), keep)
        journal = Journal(str(journal.path))
    journal.append(entry)
    return rotated
`;

/** name -> reference with one plausible wrong rule. */
const MUTANTS: Record<string, readonly [string, string]> = {
	boundary_strict_gt: ["return p.stat().st_size >= max_bytes", "return p.stat().st_size > max_bytes"],
	no_keep_validation: [
		`    if not isinstance(keep, int) or keep < 1:\n        raise RotationError("keep must be >= 1")\n    base = Path(path)`,
		"    base = Path(path)",
	],
	shift_ascending: ["for i in range(keep - 1, 0, -1):", "for i in range(1, keep):"],
	append_skips_max_bytes_validation: [
		`def append_with_rotation(journal: Journal, entry: dict, max_bytes: int, keep: int) -> list[str]:\n    if not isinstance(max_bytes, int) or max_bytes < 1:\n        raise RotationError("max_bytes must be >= 1")\n    if not isinstance(keep, int) or keep < 1:`,
		`def append_with_rotation(journal: Journal, entry: dict, max_bytes: int, keep: int) -> list[str]:\n    if not isinstance(keep, int) or keep < 1:`,
	],
	append_rotates_after_boundary_not_at_it: [
		"if journal.size_bytes() >= max_bytes:",
		"if journal.size_bytes() > max_bytes:",
	],
	append_truncates_return_list: [
		"    journal.append(entry)\n    return rotated",
		"    journal.append(entry)\n    return rotated[:1]",
	],
	// Skips rotation in append entirely; only "entries survive rotation" and
	// the boundary-return check can catch it.
	append_never_rotates: [
		`    rotated: list[str] = []\n    if journal.size_bytes() >= max_bytes:\n        rotated = rotate(journal.path.as_posix(), keep)\n        journal = Journal(str(journal.path))\n    journal.append(entry)\n    return rotated`,
		"    journal.append(entry)\n    return []",
	],
	error_not_value_error: ["class RotationError(ValueError):", "class RotationError(Exception):"],
	should_rotate_no_validation: [
		`def should_rotate(path: str, max_bytes: int) -> bool:\n    if not isinstance(max_bytes, int) or max_bytes < 1:\n        raise RotationError("max_bytes must be >= 1")\n`,
		"def should_rotate(path: str, max_bytes: int) -> bool:\n",
	],
	// Deletes only slot keep+1: contiguous-chain checks catch it, sparse check does not.
	deletes_only_keep_plus_one: ["if int(suffix) > keep:", "if int(suffix) == keep + 1:"],
	// Skips the delete pass entirely: only the sparse high-suffix check can
	// catch it when no contiguous chain exceeds keep.
	keeps_sparse_beyond_keep: [
		`    for entry in base.parent.iterdir():\n        if not entry.name.startswith(base.name + "."):\n            continue\n        suffix = entry.name[len(base.name) + 1 :]\n        if not suffix.isdigit():\n            continue\n        if int(suffix) > keep:\n            entry.unlink()\n`,
		"",
	],
} as const;

function applyMutation(source: string, [find, replace]: readonly [string, string]): string {
	if (!source.includes(find)) throw new Error(`Mutant anchor not found: ${find.slice(0, 60)}...`);
	return source.replace(find, replace);
}

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(rotationSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-verifier-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "journal.py"), join(root, "journal.py")),
			copyFile(join(fixtureRoot, "test_rotation.py"), join(root, "test_rotation.py")),
			writeFile(join(root, "rotation.py"), rotationSource),
		]);
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
	return [...new Set(result.failures.filter((f) => !f.startsWith("test_rotation.")).map((f) => f.split(":")[0]))];
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("log-rotate-v2 verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.tests).toBeGreaterThanOrEqual(18);
		expect(result.failures).toEqual([]);
	});

	// Every named verifier check must attribute at least one mutant. A check
	// that never fires is dead weight and invalidates capability evidence.
	it("attributes every named check to at least one mutant", async () => {
		const attributed = new Set<string>();
		for (const [find, replace] of Object.values(MUTANTS)) {
			const result = await runVerifier(applyMutation(REFERENCE, [find, replace]));
			for (const name of namedChecks(result)) attributed.add(name);
		}
		const expected = [
			"size equal to limit rotates",
			"max_bytes 0 rejected",
			"keep 0 rejected",
			"rotation shifts chain and drops beyond keep",
			"rotate without active file still shifts",
			"sparse high suffix dropped",
			"append_with_rotation validates parameters",
			"append rotates at boundary and returns rotate list",
			"entries survive rotation",
			"RotationError subclasses ValueError",
		];
		const missing = expected.filter((name) => !attributed.has(name));
		expect(missing, "named checks with no attributing mutant").toEqual([]);
	});
});
