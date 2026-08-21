# Journal Rotation Specification

All behavior in this specification is normative: the public API must behave
exactly as described here, including the error cases, even where
`test_rotation.py` does not check them.

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

Rotates the numbered files `path.1 .. path.keep` and the active file `path`.

**Slot set after rotation.** The numbered files that may exist after rotation
are `path.1 .. path.keep`; a slot with suffix strictly greater than `keep`
must not exist afterward.

**Shift rule.** Let `i` range from `keep-1` down to `1`. For each `i`, if
`path.i` exists, move it to `path.(i+1)`. Explicitly delete every existing
`path.j` with `j > keep`. Perform the moves in descending suffix order so a
file is never overwritten before it is moved.

**Active file.** If `path` exists (an active journal file), move it to
`path.1`.

If `path` does not exist, the shift/delete steps above still run; only the
active-file move is skipped. This is **not** a no-op when any rotated file
exists.

**Return value.** The sorted list (ascending numeric suffix) of the filenames
of all numbered slots that exist after the shift, e.g.
`["journal.jsonl.1", "journal.jsonl.2"]`. The `.1` slot is newest.

**Parameter validation.** `keep >= 1` is required; otherwise raise
`RotationError` with the message `"keep must be >= 1"`.

**Worked example, `keep = 2`.** Before: `path` = "active", `path.1` = "one",
`path.2` = "two", `path.3` = "three". After:
1. delete `path.3` (suffix 3 > 2); delete `path.2` (suffix 2 > 2);
2. move `path.1` -> `path.2`;
3. move `path` -> `path.1`;
4. result: `path.1` = "active", `path.2` = "one"; return
   `["journal.jsonl.1", "journal.jsonl.2"]`.

**Worked example, `keep = 3`, no active file.** Before: `path.1` = "one".
After:
1. no suffix > 3 to delete; `path.2` / `path.3` absent, skipped;
2. move `path.1` -> `path.2`;
3. `path` absent, so no active move;
4. result: `path.2` = "one"; return `["journal.jsonl.2"]`.

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