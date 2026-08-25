/**
 * SPEC-faithful config-migrate reference source and the violating-mutant
 * catalog, shared by the verifier-attribution suite and the verification-
 * signal characterization. Each mutant is one plausible wrong rule applied to
 * MIGRATE_REF; every mutant must be rejected by the external verifier.
 */

export const MIGRATE_REF = `"""Migrate config files per SPEC.md."""
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
export const MUTANTS: Record<string, readonly [find: string, replace: string]> = {
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

export function applyMutation([find, replace]: readonly [string, string]): string {
	if (!MIGRATE_REF.includes(find)) throw new Error(`Mutant anchor not found: ${find.slice(0, 60)}...`);
	return MIGRATE_REF.replace(find, replace);
}
