# Data Pipeline Specification

All behavior in this specification is normative. Four modules compose a data
pipeline: `parser.py`, `validator.py`, `transformer.py`, `pipeline.py`. Each
module's public API is fixed below. The pipeline wires them in order:
parse → validate → transform. An input that cannot be parsed is silently
skipped. An input that fails validation is counted as invalid and excluded
from transformation but does not stop the pipeline.

## Input format

Plain text. Each non-blank, non-comment line is one record. A comment line
starts with `#` (first character). A record is space-separated `key=value`
tokens where `key` is a lowercase identifier (`[a-z]+`) and `value` is any
non-space string (no quoting). Repeated keys in a line take the last value.
Lines with no `=` sign are malformed and silently skipped.

## `parser.py`

### `parse(text: str) -> list[dict[str, str]]`

- Split `text` on newlines.
- Skip blank lines, comment lines (first char `#`), and malformed lines (no
  `=`).
- For each remaining line: split on whitespace; for each token, split on the
  first `=` into key and value; store `key → value` in a dict.
- Return the list of record dicts in line order.

## `validator.py`

### `validate(records: list[dict[str, str]]) -> tuple[list[dict], list[dict]]`

Returns `(valid, invalid)` where both are lists of the original record dicts.

A record is **valid** iff ALL of the following hold:

1. `name` key exists and its value is non-empty.
2. `age` key exists and its value is convertible to `int` in `[0, 150]`.
3. `role` key exists and its value is one of `"admin"`, `"user"`, `"guest"`.
4. **Cross-field rule:** if `role == "admin"`, then `int(age) >= 18`.

If any rule fails the record is invalid. Validation checks rules 1–4 in
order and stops at the first failure for each record.

## `transformer.py`

### `transform(records: list[dict[str, str]]) -> list[str]`

1. **Filter:** keep only records where `int(age) >= 18`.
2. **Group** remaining records by `role`.
3. **Aggregate** each group: `count`, `min(age)`, `max(age)` (using
   `int(age)`).
4. **Sort** groups by `count` descending, then by `role` ascending
   (alphabetical).
5. Return one string per group in sorted order: `"role=count:min:max"`.

If the input list is empty (after filtering) return `[]`.

## `pipeline.py`

### `run(text: str) -> tuple[list[str], dict[str, int]]`

1. `records = parser.parse(text)`
2. `valid, invalid = validator.validate(records)`
3. `output = transformer.transform(valid)`
4. Return `(output, stats)` where:
   ```
   stats = {
       "parsed": len(records),
       "valid": len(valid),
       "invalid": len(invalid),
       "output_groups": len(output),
   }
   ```

## Worked example (end-to-end)

Input:
```
name=John age=30 role=admin
name=Jane age=25 role=user
name=Bob age=35 role=admin
age=17 role=user
name=Eve age=28 role=admin
name=Charlie age=45 role=guest
name=Dave age=12 role=user
```

**Parse** (7 lines, all have `=`):
`[{name:John,age:30,role:admin}, {name:Jane,age:25,role:user}, {name:Bob,age:35,role:admin}, {age:17,role:user}, {name:Eve,age:28,role:admin}, {name:Charlie,age:45,role:guest}, {name:Dave,age:12,role:user}]`

**Validate:**
- John: name ✓, age=30 ✓, role=admin ✓, admin age≥18 ✓ → valid
- Jane: name ✓, age=25 ✓, role=user ✓ → valid
- Bob: name ✓, age=35 ✓, role=admin ✓, admin age≥18 ✓ → valid
- `{age:17,role:user}`: **no `name` key** → invalid (rule 1)
- Eve: name ✓, age=28 ✓, role=admin ✓, admin age≥18 ✓ → valid
- Charlie: name ✓, age=45 ✓, role=guest ✓ → valid
- Dave: name ✓, age=12 ✓, role=user ✓ → valid (cross-field only applies to admin)

Valid:6, Invalid:1.

**Transform** (filter age ≥ 18):
- Dave (age=12) filtered. Remaining: John(30), Jane(25), Bob(35), Eve(28), Charlie(45).

Groups:
- admin: 3 records, min=28, max=35
- user: 1 record, min=25, max=25
- guest: 1 record, min=45, max=45

Sort (count desc, role asc):
1. admin=3:28:35
2. guest=1:45:45
3. user=1:25:25

**Output:**
```
admin=3:28:35
guest=1:45:45
user=1:25:25
```

**Stats:** `{parsed: 7, valid: 6, invalid: 1, output_groups: 3}`