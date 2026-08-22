# Pipeline Runner Specification

All behavior in this specification is normative. A three-module pipeline
runner executes registered stages as a directed acyclic graph.

## Module layout

The workspace contains exactly three modules: `errors.py`, `stages.py`, and
`runner.py`. All imports between them are plain top-level imports.

## `errors.py`

```python
class CycleError(Exception): ...
class StageFailureError(Exception):
    def __init__(self, stage: str):
        super().__init__(stage)
        self.stage = stage
```

- `CycleError` is raised when the dependency graph contains a cycle.
- `StageFailureError` carries the failing stage's name in its `stage`
  attribute. Stages raise it themselves; the runner never wraps other
  exception types.

## `stages.py`

```python
STAGES: dict[str, callable]

def stage(name: str) -> callable: ...
def run_stage(name: str, payload: dict) -> dict: ...
```

- `STAGES` maps stage name to the registered function.
- `@stage(name)` registers the decorated function under `name`. Registering
  a name twice overwrites the earlier entry (last registration wins).
- `run_stage(name, payload)` calls the registered function with `payload`
  and returns its result. Unknown `name` raises `KeyError`.

## `runner.py`

```python
from stages import STAGES
from errors import CycleError, StageFailureError

class Pipeline:
    def __init__(self, edges: list[tuple[str, str]]) -> None: ...
    def execute(self, entry_payload: dict, stop_on_error: bool = True) -> dict: ...
```

### `__init__(self, edges)`

Stores edges internally. Each tuple `(a, b)` means "b runs after a".
Duplicate identical tuples are ignored (deduplicated). Stage names are
plain strings; names not present in `STAGES` are legal here and only fail
at `execute` time.

### Graph semantics

- **Nodes**: every distinct stage name appearing in any edge.
- **Dependency**: `(a, b)` makes `a` a dependency of `b` (`a` must run
  before `b`).
- **Roots**: nodes with no dependencies among the nodes.
- **Execution order**: repeatedly run ready nodes — nodes whose
  dependencies have all already run — choosing among ready nodes by
  lexicographic stage-name order. This makes runs deterministic.
- **Reachability**: execution starts from roots and follows edges forward;
  every node reachable from some root via dependency direction runs exactly
  once. Nodes unreachable from any root do not exist in this model because
  every node either has no dependencies (root) or is reached from one.
  (Formally: run the lexicographic topological order of the whole node set,
  starting from roots.)

### Payload flow

Each stage receives exactly one argument, a dict:

```python
{**entry_payload, **output_of_a, **output_of_b, ...}
```

where the trailing entries are the returned dicts of every
already-run stage, merged in execution order (the union of their keys).
When keys collide, later-running stages' outputs overwrite earlier ones and
both overwrite `entry_payload`. Stages may return any value; the value is
merged only if it is a dict, otherwise it contributes nothing to the
payload.

### `execute(self, entry_payload, stop_on_error=True) -> dict`

1. Build the node set from stored edges. If it is empty return exactly:
   `{"results": {}, "failed": [], "skipped": []}`.
2. Detect cycles before running anything: if the graph has a cycle, raise
   `CycleError` whose string message contains at least one stage name from
   the cycle. No stage runs in this case.
3. Run nodes in the deterministic order above. Before running node `s`,
   look up `STAGES[s]`: an unknown name raises `KeyError` immediately
   (nothing further runs).
4. Call the function with the payload dict. Outcomes:
   - Success: record `results[s] = returned_dict`.
   - The function raises `StageFailureError`: append `s` to `failed`.
     If `stop_on_error` is true, stop immediately (later nodes neither run
     nor appear in `skipped`).
   - Any other exception propagates out of `execute` unchanged.
5. A node whose dependency failed (or was skipped due to an upstream
   failure) is appended to `skipped` instead of running. Skipped nodes are
   recorded in lexicographic order within each frontier.
6. Return exactly:

```python
{"results": {name: output}, "failed": [names], "skipped": [names]}
```

`failed` lists failures in the order they occurred; `skipped` lists skips
in the order they were detected.

## Worked example 1 — diamond graph

Edges: `[("a","c"), ("b","c"), ("a","d")]`. Registered stages `a`, `b`, `d`
return distinct dicts; `c` records what it received.

Ready set starts as `{a, b}` → run `a`, then `b`; then `{c, d}` → run `c`,
then `d`.

Stage `a` returns `{"a": 1}`, `b` returns `{"b": 2}`, so `c` receives
`{"env": ..., **{"a": 1}, **{"b": 2}}` = `{"env": "prod", "a": 1, "b": 2}`.
Result order proves the tie-break: `results` keys insert as
`"a", "b", "c", "d"`.

## Worked example 2 — failure propagation

Edges: `[("a","b"), ("b","c"), ("a","d")]`. Stage `b` raises
`StageFailureError("b")`.

- With `stop_on_error=True`: result is
  `{"results": {"a": ...}, "failed": ["b"], "skipped": []}`.
- With `stop_on_error=False`: after the failure, ready nodes are `c` and
  `d`; `d` runs (its dependency `a` succeeded), `c` is skipped. Result is
  `{"results": {"a": ..., "d": ...}, "failed": ["b"], "skipped": ["c"]}`.

## Worked example 3 — cycle detection

Edges: `[("x","y"), ("y","z"), ("z","x")]`. Every node depends on another,
so there are no roots; `execute` raises `CycleError` before running
anything, and the message mentions `"x"` or `"y"` or `"z"`.

## Worked example 4 — payload merge precedence

Entry payload `{"env": "prod", "shared": "entry"}`. Stage `p` returns
`{"shared": "from-p", "p_out": 1}`; stage `q` (depending on `p`) returns
`{"q_out": 2}`. Stage `r` depending on both receives
`{"env": "prod", "shared": "from-p", "p_out": 1, "q_out": 2}`.
