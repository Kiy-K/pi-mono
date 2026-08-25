/**
 * SPEC-faithful data-pipeline reference sources and the violating-mutant
 * catalog, shared by the verifier-attribution suite and the verification-
 * signal characterization. Each mutant is one plausible wrong rule applied to
 * one module of REFERENCE; every mutant must be rejected by the external
 * verifier. EQUIVALENT_MUTANTS are proven equivalent under the SPEC API and
 * must stay SURVIVED by the verifier.
 */

export const REFERENCE: Record<string, string> = {
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

/** name -> [module, find, replace]: one plausible wrong rule. */
export const MUTANTS: Record<string, readonly [module: string, find: string, replace: string]> = {
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
export const EQUIVALENT_MUTANTS: Record<string, readonly [module: string, find: string, replace: string]> = {
	type_error_tolerated: ["validator.py", "except ValueError:", "except (ValueError, TypeError):"],
};

export function applyMutation(moduleName: string, [find, replace]: readonly [string, string]): string {
	const source = REFERENCE[moduleName];
	if (!source.includes(find)) throw new Error(`Mutant anchor not found in ${moduleName}: ${find.slice(0, 60)}...`);
	return source.replace(find, replace);
}
