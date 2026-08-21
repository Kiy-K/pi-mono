# Config Migration Specification

All behavior in this specification is normative. A migration tool transforms a
set of JSON config files from schema v1 to schema v2. The workspace directory
contains zero or more `.json` files, each a standalone config object.

## Public API

### `migrate(workspace: str) -> dict[str, int]`

Reads every `.json` file in `workspace`, applies the migration rules below,
writes the migrated content back to the same file paths, and returns stats.

Return value:
```python
{
    "files_migrated": <int>,    # number of files written
    "fields_renamed": <int>,    # total host→endpoint renames across all files
    "ports_coerced": <int>,     # total port int→string coercions across all files
    "references_inlined": <int> # total _config references resolved across all files
}
```

## Migration rules (applied in this exact order per file)

### Rule 1 — Rename `host` to `endpoint`

If the JSON object contains a key `"host"`, rename it to `"endpoint"`,
preserving the value. Count this as one rename.

### Rule 2 — Coerce `port` from int to string

If the JSON object contains a key `"port"` whose value is an integer, convert
it to a string (e.g., `5432` → `"5432"`). Count this as one coercion.

### Rule 3 — Add default `enabled`

If the JSON object does **not** contain a key `"enabled"`, add
`"enabled": true`.

### Rule 4 — Add `"version": 2`

Add `"version": 2` to every migrated file (overwrites if present).

### Rule 5 — Resolve cross-references (ordering-dependent)

If a key ends with `_config` and its value is a string ending in `.json`, this
is a cross-reference. Resolve it:

1. Read the referenced file from the workspace (it must already have been
   migrated by rules 1–4).
2. Replace the key `"X_config"` with `"X_endpoint"` where `X` is the prefix
   before `_config`.
3. Set the value to the `"endpoint"` field of the already-migrated referenced
   file.
4. Delete the original `_config` key.
5. Count this as one inlining.

**Ordering constraint:** Process files with zero `_config` keys first (no
outgoing references), then files that reference them. If a file references
another that also has `_config` keys, the reference chain must be followed
to its root before resolving.

## Error handling

- If a `.json` file contains invalid JSON, skip it (do not crash, do not
  write it, do not count it in `files_migrated`).
- If a `_config` reference points to a file that does not exist in the
  workspace, skip that reference (do not crash, do not count it in
  `references_inlined`).

## Worked example

Input workspace contains three files:

`db.json`:
```json
{"host": "localhost", "port": 5432, "name": "mydb"}
```

`cache.json`:
```json
{"host": "redis.local", "port": 6379}
```

`app.json`:
```json
{"host": "0.0.0.0", "port": 8080, "db_config": "db.json", "cache_config": "cache.json"}
```

**Step 1 — migrate each file (rules 1–4):**

db.json: host→endpoint, port 5432→"5432", add enabled:true, add version:2
→ `{"endpoint":"localhost","port":"5432","name":"mydb","enabled":true,"version":2}`
(1 rename, 1 coercion)

cache.json: host→endpoint, port 6379→"6379", add enabled:true, add version:2
→ `{"endpoint":"redis.local","port":"6379","enabled":true,"version":2}`
(1 rename, 1 coercion)

app.json (before reference resolution): host→endpoint, port 8080→"8080",
add enabled:true, add version:2
→ `{"endpoint":"0.0.0.0","port":"8080","db_config":"db.json","cache_config":"cache.json","enabled":true,"version":2}`
(1 rename, 1 coercion)

**Step 2 — resolve references (rule 5):**

app.json has `db_config:"db.json"` → `db_endpoint:"localhost"` (from migrated
db.json's endpoint). Delete `db_config`. (1 inlining)

app.json has `cache_config:"cache.json"` → `cache_endpoint:"redis.local"`
(from migrated cache.json's endpoint). Delete `cache_config`. (1 inlining)

**Final files:**

db.json:
```json
{"endpoint":"localhost","port":"5432","name":"mydb","enabled":true,"version":2}
```

cache.json:
```json
{"endpoint":"redis.local","port":"6379","enabled":true,"version":2}
```

app.json:
```json
{"endpoint":"0.0.0.0","port":"8080","db_endpoint":"localhost","cache_endpoint":"redis.local","enabled":true,"version":2}
```

**Stats:**
```python
{"files_migrated": 3, "fields_renamed": 3, "ports_coerced": 3, "references_inlined": 2}
```