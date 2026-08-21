# Event Store Specification

All behavior in this specification is normative. An `EventStore` maintains
key-value state in memory and persists it to a JSONL file on disk.

## Persistence format

One JSON object per line. Each line has exactly two keys: `"key"` (string)
and `"value"` (string or null). A line with `"value": null` represents a
deletion that has been compacted away — such lines never appear in the file.
The file is a materialized snapshot: it contains exactly one line per key
currently in the store, with a non-null string value. The file is
newline-terminated.

## `EventStore`

### `__init__(self, db_path: str)`

- `db_path` is the path to the JSONL persistence file.
- If the file exists, load its contents into the in-memory state. Each line
  `{"key":"k","value":"v"}` sets key `k` to value `v`. Malformed lines
  (missing key/value, non-string key, null value) are silently skipped.
- If the file does not exist, start with empty state.

### `apply(self, events: list[dict]) -> dict`

Process a list of events in order. Each event is a dict with a `"type"` key.

- `{"type": "set", "key": "k", "value": "v"}`: set key `k` to value `v`
  (string). If `k` already exists, update it.
- `{"type": "delete", "key": "k"}`: remove key `k` from state. If `k` does
  not exist, this is a no-op (still counts as deleted).
- Events with missing `"type"`, unknown type, missing `"key"`, or missing
  `"value"` (for set) are silently skipped.

After processing ALL events, write the current in-memory state to the
persistence file (overwrite entirely). Return stats:
```python
{"processed": N, "set": N, "deleted": N}
```
`processed` counts events that were actually applied (skipped events do not
count). `set` counts set events applied (including updates to existing keys).
`deleted` counts delete events applied.

### `get(self, key: str) -> str | None`

Return the value for `key`, or `None` if the key does not exist.

### `keys(self) -> list[str]`

Return a sorted list of all keys currently in the store.

### `verify(self) -> bool`

Reload the persistence file from disk, reconstruct state, and compare with
the current in-memory state. Return `True` if they match exactly (same keys,
same values). Return `False` if they differ. This does NOT modify in-memory
state; it is a read-only consistency check.

## Worked example

```python
store = EventStore("/tmp/db.jsonl")

# First batch
store.apply([
    {"type": "set", "key": "a", "value": "1"},
    {"type": "set", "key": "b", "value": "2"},
])
# state: {"a": "1", "b": "2"}
# disk:  {"key":"a","value":"1"}\n{"key":"b","value":"2"}\n
# returns {"processed": 2, "set": 2, "deleted": 0}

# Second batch — update a, delete b
store.apply([
    {"type": "set", "key": "a", "value": "10"},
    {"type": "delete", "key": "b"},
])
# state: {"a": "10"}
# disk:  {"key":"a","value":"10"}\n
# returns {"processed": 2, "set": 1, "deleted": 1}

store.get("a")       # "10"
store.get("b")       # None
store.keys()         # ["a"]
store.verify()       # True
```