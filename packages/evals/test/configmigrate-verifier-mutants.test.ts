import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/config-migrate.py.
 *
 * Audit history: the verifier originally never fed a pre-existing `version`
 * field or a non-int `port` (string/bool) through migrate, so mutants
 * violating SPEC rule 4's overwrite semantics and rule 2's integer-only type
 * boundary passed every check and the public suite. Two checks were added;
 * this suite pins the reference implementation and the violating mutants so
 * those holes cannot reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "config-migrate");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "config-migrate.py");

const REFERENCE = `"""Migrate config files per SPEC.md."""
import json
import os


def migrate(workspace):
    stats = {"files_migrated": 0, "fields_renamed": 0, "ports_coerced": 0, "references_inlined": 0}
    names = sorted(n for n in os.listdir(workspace) if n.endswith(".json"))
    configs = {}
    for name in names:
        path = os.path.join(workspace, name)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        configs[name] = data

    def migrate_one(data):
        renames = coercions = 0
        if "host" in data:
            data["endpoint"] = data.pop("host")
            renames += 1
        if "port" in data and isinstance(data["port"], int) and not isinstance(data["port"], bool):
            data["port"] = str(data["port"])
            coercions += 1
        if "enabled" not in data:
            data["enabled"] = True
        data["version"] = 2
        return data, renames, coercions

    # Rules 1-4 on reference-free files first; keep referrers for pass 2.
    deferred = []
    for name, data in configs.items():
        has_ref = any(k.endswith("_config") and isinstance(v, str) and v.endswith(".json")
                      for k, v in data.items())
        if has_ref:
            deferred.append(name)
            continue
        data, r, c = migrate_one(data)
        stats["fields_renamed"] += r
        stats["ports_coerced"] += c
        with open(os.path.join(workspace, name), "w", encoding="utf-8") as f:
            json.dump(data, f)
        stats["files_migrated"] += 1

    # Resolve chains iteratively until fixpoint.
    pending = {n: configs[n] for n in deferred}
    while pending:
        progressed = False
        for name in sorted(pending):
            data = pending[name]
            refs = {k: v for k, v in data.items()
                    if k.endswith("_config") and isinstance(v, str) and v.endswith(".json")}
            unresolved = [k for k, v in refs.items() if v not in configs]
            if unresolved:
                # Missing references are skipped: drop the key without counting.
                for k in [k for k, v in refs.items() if v not in configs]:
                    del data[k]
                refs = {k: v for k, v in refs.items() if v in configs}
            ready = all(r not in pending or r == name for r in refs.values())
            if refs and not ready:
                continue
            for k, target_name in list(refs.items()):
                target = configs[target_name]
                endpoint = target.get("endpoint")
                new_key = k[: -len("_config")] + "_endpoint"
                data[new_key] = endpoint
                del data[k]
                stats["references_inlined"] += 1
            data, r, c = migrate_one(data)
            stats["fields_renamed"] += r
            stats["ports_coerced"] += c
            with open(os.path.join(workspace, name), "w", encoding="utf-8") as f:
                json.dump(data, f)
            stats["files_migrated"] += 1
            del pending[name]
            progressed = True
        if not progressed:
            break
    return stats
`;

/** name -> one plausible wrong rule. */
const MUTANTS: Record<string, readonly [find: string, replace: string]> = {
	host_rename_dropped: [
		'if "host" in data:\n            data["endpoint"] = data.pop("host")\n            renames += 1',
		"pass",
	],
	port_coercion_dropped: [
		'if "port" in data and isinstance(data["port"], int) and not isinstance(data["port"], bool):\n            data["port"] = str(data["port"])\n            coercions += 1',
		"pass",
	],
	string_port_counted_as_coerced: [
		'if "port" in data and isinstance(data["port"], int) and not isinstance(data["port"], bool):',
		'if "port" in data and not isinstance(data["port"], bool):',
	],
	bool_port_counted_as_coerced: ['and not isinstance(data["port"], bool)', ""],
	enabled_always_overwritten: [
		'if "enabled" not in data:\n            data["enabled"] = True',
		'data["enabled"] = True',
	],
	version_only_added_when_absent: [
		'data["version"] = 2',
		'if "version" not in data:\n            data["version"] = 2',
	],
	version_never_added: ['data["version"] = 2', "pass"],
	inline_uses_filename_instead_of_endpoint: ['endpoint = target.get("endpoint")', "endpoint = target_name"],
	config_key_kept_after_inline: [
		'del data[k]\n                stats["references_inlined"] += 1',
		'stats["references_inlined"] += 1',
	],
	invalid_json_raises: [
		"except (json.JSONDecodeError, UnicodeDecodeError):\n            continue",
		"except (json.JSONDecodeError, UnicodeDecodeError):\n            raise",
	],
	missing_reference_still_counted: [
		"for k in [k for k, v in refs.items() if v not in configs]:\n                    del data[k]",
		'for k in [k for k, v in refs.items() if v not in configs]:\n                    del data[k]\n                    stats["references_inlined"] += 1',
	],
};

function applyMutation([find, replace]: readonly [string, string]): string {
	if (!REFERENCE.includes(find)) throw new Error(`Mutant anchor not found: ${find.slice(0, 60)}...`);
	return REFERENCE.replace(find, replace);
}

interface VerifierResult {
	passed: boolean;
	tests: number;
	failures: string[];
}

async function runVerifier(migrateSource: string): Promise<VerifierResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-configmigrate-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_migrate.py"), join(root, "test_migrate.py")),
			writeFile(join(root, "migrate.py"), migrateSource),
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
				.filter((failure) => !failure.startsWith("test_migrate."))
				.map((failure) => failure.split(":")[0]),
		),
	];
}

describe("config-migrate verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, mutation] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant`, async () => {
			const result = await runVerifier(applyMutation(mutation));
			expect(result.passed).toBe(false);
			expect(
				namedChecks(result).length + result.failures.filter((f) => f.startsWith("test_migrate.")).length,
			).toBeGreaterThan(0);
			if (name !== "version_never_added") {
				// version_never_added is attributed by the public suite alone;
				// every other mutant must be caught by a named verifier check.
				expect(namedChecks(result), `${name} must be caught by a named check`).not.toEqual([]);
			}
		});
	}
});
