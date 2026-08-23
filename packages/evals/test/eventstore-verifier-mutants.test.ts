import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Mutant attribution for diagnostics/verifiers/event-store.py.
 *
 * The verifier must reject loaders that violate SPEC's persistence-loading
 * rules. History: the verifier originally never fed malformed lines to
 * EventStore.__init__, so loaders that crashed on invalid JSON or loaded
 * null/non-string values passed every check. This suite pins the reference
 * implementation and the malformed-loading mutants so the hole cannot reopen.
 */

const execFileAsync = promisify(execFile);

const packageRoot = join(import.meta.dirname, "..");
const fixtureRoot = join(packageRoot, "diagnostics", "tasks", "event-store");
const verifierPath = join(packageRoot, "diagnostics", "verifiers", "event-store.py");

const REFERENCE = `"""Event store per SPEC.md."""
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
const MUTANTS: Record<string, readonly [string, string]> = {
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
	const root = await mkdtemp(join(tmpdir(), "pi-eventstore-mutant-"));
	try {
		await Promise.all([
			copyFile(join(fixtureRoot, "test_store.py"), join(root, "test_store.py")),
			writeFile(join(root, "store.py"), rotationSource),
		]);
		// The verifier exits non-zero when checks fail; a caught mutant is an
		// expected rejection, so parse stdout instead of treating exit 1 as error.
		// Purge __pycache__: importlib caches .pyc by mtime+size and same-size
		// mutants written quickly could otherwise validate stale bytecode.
		await rm(join(root, "__pycache__"), { recursive: true, force: true });
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
	const names: string[] = [];
	for (const failure of result.failures) {
		if (!failure.startsWith("test_store.")) names.push(failure.split(":")[0]);
	}
	return [...new Set(names)];
}

describe("event-store verifier mutant attribution", () => {
	it("accepts a SPEC-faithful reference implementation", async () => {
		const result = await runVerifier(REFERENCE);
		expect(result.passed).toBe(true);
		expect(result.failures).toEqual([]);
	});

	for (const [name, [find, replace]] of Object.entries(MUTANTS)) {
		it(`rejects the ${name} mutant via the malformed-lines check`, async () => {
			const result = await runVerifier(applyMutation(REFERENCE, [find, replace]));
			expect(result.passed).toBe(false);
			expect(namedChecks(result), `${name} must be caught by 'init skips malformed lines'`).toContain(
				"init skips malformed lines",
			);
		});
	}
});
