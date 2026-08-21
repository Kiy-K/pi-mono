# Journal Rotation Specification v2 (clarified)

All behavior in this specification is normative: the public API must behave
exactly as described here, including the error cases, even where
`test_rotation.py` does not check them.

This is a **clarification of v1** — the API surface, function signatures, error
messages, and `RotationError` semantics are unchanged. Only the `rotate(path,
keep)` slot semantics are made explicit and internally consistent, and the
missing-active behavior is stated without contradiction. It must be shipped
under a **new task identity and hash, with a fresh baseline**; it does not
replace the v1 task in place.

## Module `journal.py`

`journal.py` is already complete and must not change its public behavior:
`Journal(path)`, `append(entry)`, `read_all()`, and `size_bytes()` keep their
current contracts.

## Module `rotation.py`

### `should_rotate(path, max_bytes) -> bool`

- Returns `True` if and only if `path` exists as a file and its current size
  in bytes is `>= max_bytes`.
- A missing path returns `False`.
- `max_bytes >= 1` is required; otherwise raise `RotationError` with the
  message `"max_bytes must be >= 1"`.

### `rotate(path, keep) -> list[str]`

- **Slot set after rotation:** numbered files `path.1 .. path.keep` are the
  slots that exist after rotation (a slot may be absent if it was never
  created). A slot with suffix strictly greater than `keep` must not exist
  afterward.
- Shift rule (perform in descending suffix order so no file is overwritten
  before it is moved):
  - for each `i` from `keep-1` down to `1`, if `path.i` exists, move it to
    `path.(i+1)`;
  - explicitly delete any `path.j` with `j > keep` that exists.
- If `path` exists (an active journal file), move it to `path.1`.
- **If `path` does not exist:** the shift/delete steps above still run; there
  is simply no active file to move. This is **not** a no-op when any rotated
  file exists.
- Returns the sorted list (ascending numeric suffix) of the filenames of all
  rotation slots that exist after the shift, e.g. `["journal.jsonl.1",
  "journal.jsonl.2"]`. `.1` is newest.
- `keep >= 1` is required; otherwise raise `RotationError` with the message
  `"keep must be >= 1"`.
- Worked example (`keep = 2`, before: `path`="active", `path.1`="one",
  `path.2`="two", `path.3`="three"):
  1. delete `path.3` (suffix 3 > keep 2); delete `path.2` (suffix 2 > keep 2);
  2. move `path.1` -> `path.2` (`i=1`);  
  3. move `path` -> `path.1`;
  4. result: `path.1`="active", `path.2`="one"; return
     `["journal.jsonl.1", "journal.jsonl.2"]`.
- Worked example (`keep = 3`; before: no active, `path.1`="one"):
  1. no suffix > 3 and no `path.2`/`path.3` to delete;
  2. move `path.1` -> `path.2` (`i=1`; `path.2`,`path.3` absent, skipped);
  3. `path` absent, so no active move;
  4. result: `path.2`="one"; return `["journal.jsonl.2"]`.

### `append_with_rotation(journal, entry, max_bytes, keep) -> list[str]`

- If `should_rotate(journal.path, max_bytes)` is true, first performs
  `rotate(journal.path, keep)`, then appends the entry to the fresh journal.
  Otherwise appends directly.
- Returns the same list `rotate` returned (`[]` when no rotation happened).
- The append must go through `journal.append(entry)`; the entry must be
  readable with `journal.read_all()` afterwards.
- Validates `max_bytes` and `keep` exactly like the two functions above, with
  the same error messages.

- `RotationError` subclasses `ValueError` and is defined in `rotation.py`.

## Summary of v1 -> v2 changes (documentation only)

1. **Removed the off-by-one truncation prose.** v1 literally read
   "`path.(keep-1)` is deleted, `path.(keep-2)` becomes `path.(keep-1)`, ...,
   `path.1` becomes `path.2`, and `path` becomes `path.1`" — which, taken
   literally, preserves only `keep-1` slots. v2 states the preserved set is
   `path.1 .. path.keep`, the deletion bound is suffix `> keep`, and the shift
   is `i -> i+1` for `i in keep-1 .. 1` in descending order.
2. **Resolved the missing-active contradiction.** v1 said both "no-op
   returning `[]`" and "existing rotated files are still shifted up by one".
   v2 states the shift/delete steps always run and only the active-file move
   is conditional, and that the return is non-empty when any rotated file
   remains.
3. **Added explicit shift ordering** (descending suffix) to prevent
   overwrite-before-move ambiguity.