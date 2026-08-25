/**
 * SPEC-faithful event-store reference source and the violating-mutant
 * catalog, shared by the verifier-attribution suite and the verification-
 * signal characterization. Each mutant is one plausible wrong loading rule
 * applied to REFERENCE; every mutant must be rejected by the external
 * verifier.
 */

export const REFERENCE = `"""Event store per SPEC.md."""
import json
import os


class EventStore:
    def __init__(self, db_path: str) -> None:
        self._path = db_path
        self._state = {}
        if os.path.exists(db_path):
            with open(db_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    key = obj.get("key")
                    value = obj.get("value")
                    if isinstance(key, str) and isinstance(value, str):
                        self._state[key] = value

    def _persist(self) -> None:
        with open(self._path, "w", encoding="utf-8") as f:
            for key in sorted(self._state):
                f.write(json.dumps({"key": key, "value": self._state[key]}) + "\\n")

    def apply(self, events):
        processed = set_c = deleted_c = 0
        for event in events:
            kind = event.get("type")
            if kind == "set":
                self._state[event["key"]] = event["value"]
                set_c += 1
                processed += 1
            elif kind == "delete":
                self._state.pop(event["key"], None)
                deleted_c += 1
                processed += 1
        self._persist()
        return {"processed": processed, "set": set_c, "deleted": deleted_c}

    def get(self, key):
        return self._state.get(key)

    def keys(self):
        return sorted(self._state)

    def verify(self):
        disk = {}
        if os.path.exists(self._path):
            with open(self._path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    disk[obj["key"]] = obj["value"]
        return disk == self._state
`;

/** name -> reference with one plausible wrong loading rule. */
export const MUTANTS: Record<string, readonly [string, string]> = {
	// Crashes on invalid JSON instead of silently skipping (SPEC: silently skipped).
	malformed_json_raises: [
		`                    try:\n                        obj = json.loads(line)\n                    except json.JSONDecodeError:\n                        continue\n`,
		"                    obj = json.loads(line)\n",
	],
	// Loads null values into state (SPEC: only string values).
	null_value_loaded: [
		"if isinstance(key, str) and isinstance(value, str):",
		"if isinstance(key, str) and value is not None:",
	],
	// Accepts non-string values such as ints.
	int_value_loaded: [
		"if isinstance(key, str) and isinstance(value, str):",
		"if isinstance(key, str) and isinstance(value, (str, int)):",
	],
	// Ignores key/value types entirely (loads missing-key lines too).
	type_checks_removed: ["if isinstance(key, str) and isinstance(value, str):", 'if "key" in obj and "value" in obj:'],
};

export function applyMutation(source: string, [find, replace]: readonly [string, string]): string {
	if (!source.includes(find)) throw new Error(`Mutant anchor not found: ${find.slice(0, 60)}...`);
	return source.replace(find, replace);
}
