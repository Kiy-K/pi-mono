import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/data-pipeline.py.
 *
 * Audit history: the verifier originally never fed an exactly-18 record
 * through transformer.transform (SPEC boundary int(age) >= 18 unobserved),
 * never distinguished leading-# comments from hashes inside values, and never
 * rejected records with an empty or missing name/age key. Four checks were
 * added; this suite pins the reference implementation and the violating
 * mutants so those holes cannot reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "data-pipeline");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "data-pipeline.py");

const REFERENCE: Record<string, string> = {
	"parser.py": `"""Parse records per SPEC.md."""


def parse(text):
    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        record = {}
        for token in line.split():
            key, _, value = token.partition("=")
            record[key] = value
        records.append(record)
    return records
`,
	"validator.py": `"""Validate records per SPEC.md."""

VALID_ROLES = {"admin", "user", "guest"}


def validate(records):
    valid, invalid = [], []
    for rec in records:
        reason = None
        name = rec.get("name")
        age_s = rec.get("age")
        role = rec.get("role")
        # Rule 1
        if not isinstance(name, str) or not name:
            reason = 1
        else:
            try:
                age = int(age_s) if age_s is not None else None
            except ValueError:
                age = None
            # Rule 2
            if age is None or isinstance(age, bool) or not (0 <= age <= 150):
                reason = 2
            # Rule 3
            elif role not in VALID_ROLES:
                reason = 3
            # Rule 4
            elif role == "admin" and age < 18:
                reason = 4
        if reason is None:
            valid.append(rec)
        else:
            invalid.append(rec)
    return valid, invalid
`,
	"transformer.py": `"""Group and aggregate per SPEC.md."""


def transform(records):
    kept = [r for r in records if int(r["age"]) >= 18]
    groups = {}
    for r in kept:
        role = r["role"]
        age = int(r["age"])
        c, lo, hi = groups.get(role, (0, None, None))
        groups[role] = (c + 1, age if lo is None else min(lo, age), age if hi is None else max(hi, age))
    ordered = sorted(groups.items(), key=lambda kv: (-kv[1][0], kv[0]))
    return [f"{role}={c}:{lo}:{hi}" for role, (c, lo, hi) in ordered]
`,
	"pipeline.py": `"""Wire the pipeline per SPEC.md."""
import parser as parser_mod
import transformer as transformer_mod
import validator as validator_mod


def run(text):
    records = parser_mod.parse(text)
    valid, invalid = validator_mod.validate(records)
    output = transformer_mod.transform(valid)
    stats = {
        "parsed": len(records),
        "valid": len(valid),
        "invalid": len(invalid),
        "output_groups": len(output),
    }
    return output, stats
`,
};

/** name -> one plausible wrong rule. */
const MUTANTS: Record<string, readonly [module: string, find: string, replace: string]> = {
	malformed_line_parsed: ["parser.py", 'or "=" not in line', ""],
	comment_rule_removed: ["parser.py", 'line.startswith("#")', 'False and line.startswith("#")'],
	hash_anywhere_starts_comment: ["parser.py", 'line.startswith("#")', '"#" in line'],
	duplicate_key_first_wins: [
		"parser.py",
		"record[key] = value",
		"if key not in record:\n                record[key] = value",
	],
	splits_on_last_equals: ["parser.py", 'token.partition("=")', 'token.rpartition("=")'],
	empty_name_accepted: ["validator.py", "if not isinstance(name, str) or not name:", "if name is None:"],
	missing_age_defaults_zero: [
		"validator.py",
		"age = int(age_s) if age_s is not None else None",
		"age = int(age_s) if age_s is not None else 0",
	],
	negative_age_accepted: ["validator.py", "not (0 <= age <= 150)", "not ((0 <= age <= 150) or age == -1)"],
	admin_age_rule_dropped: ["validator.py", 'elif role == "admin" and age < 18:', "elif False:"],
	guest_role_rejected: ["validator.py", '{"admin", "user", "guest"}', '{"admin", "user"}'],
	sort_count_ascending: ["transformer.py", "key=lambda kv: (-kv[1][0], kv[0])", "key=lambda kv: (kv[1][0], kv[0])"],
	filter_excludes_18: ["transformer.py", ">= 18", "> 18"],
	min_max_swapped: [
		"transformer.py",
		"age if lo is None else min(lo, age), age if hi is None else max(hi, age)",
		"age if lo is None else max(lo, age), age if hi is None else min(hi, age)",
	],
	stats_hide_invalid: ["pipeline.py", '"invalid": len(invalid),', '"invalid": 0,'],
};

/** Mutants the audit proved equivalent under the SPEC API surface; must stay SURVIVED. */
const EQUIVALENT_MUTANTS: Record<string, readonly [module: string, find: string, replace: string]> = {
	type_error_tolerated: ["validator.py", "except ValueError:", "except (ValueError, TypeError):"],
};

function applyMutation(moduleName: string, [find, replace]: readonly [string, string]): string {
	const source = REFERENCE[moduleName];
	if (!source.includes(find)) throw new Error(`Mutant anchor not found in ${moduleName}: ${find.slice(0, 60)}...`);
	return source.replace(find, replace);
}

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(sources: Record<string, string>): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-datapipeline-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_pipeline.py"), join(root, "test_pipeline.py")),
			writeFile(join(root, "parser.py"), sources["parser.py"]),
			writeFile(join(root, "validator.py"), sources["validator.py"]),
			writeFile(join(root, "transformer.py"), sources["transformer.py"]),
			writeFile(join(root, "pipeline.py"), sources["pipeline.py"]),
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
				.filter((failure) => !failure.startsWith("test_pipeline."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("data-pipeline verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, [moduleName, find, replace]] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier({ ...REFERENCE, [moduleName]: applyMutation(moduleName, [find, replace]) });
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_pipeline.")).length,
			).toBeGreaterThan(0);
			if (!["malformed_line_parsed", "admin_age_rule_dropped", "guest_role_rejected"].includes(name)) {
				// These are attributed by the public suite alone; every other
				// mutant must be caught by at least one named verifier check.
				expect(namedChecks(result), `${name} must be caught by a named check`).not.toEqual([]);
			}
		});
	}
	for (const [name, [moduleName, find, replace]] of Object.entries(EQUIVALENT_MUTANTS)) {
		it(`ignores the ${name} mutant (equivalent under the SPEC API)`, async () => {
			const result = await runVerifier({ ...REFERENCE, [moduleName]: applyMutation(moduleName, [find, replace]) });
			expect(result.passed).toBe(true);
		});
	}
});
