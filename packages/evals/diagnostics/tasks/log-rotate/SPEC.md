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

- Shifts rotated files up by one and moves the active journal to the first
  rotation slot:
  `path.(keep-1)` is deleted, `path.(keep-2)` becomes `path.(keep-1)`, ...,
  `path.1` becomes `path.2`, and `path` becomes `path.1`.
- Returns the sorted list of rotation paths that exist after the shift, for
  example `["journal.jsonl.1", "journal.jsonl.2"]`. Newest first (suffix .1
  is newest).
- If `path` does not exist, this is a no-op returning `[]` (existing rotated
  files are still shifted up by one, following the same rule).
- `keep >= 1` is required; otherwise raise `RotationError` with the message
  `"keep must be >= 1"`.

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
