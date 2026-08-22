# Cache-Consistency Specification

All behavior in this specification is normative. Three modules implement a
write-through versioned cache: an authoritative `Store`, a caching
`Replica` in front of it, and a `Controller` that batches writes and
audits replica freshness. There is no delete operation anywhere: once a
key exists it exists forever, and its version number only grows.

## Module layout

The workspace contains exactly three modules: `store.py`, `replica.py`,
and `controller.py`. All imports between them are plain top-level imports:

```python
from store import Store            # in replica.py and controller.py
from replica import Replica        # in controller.py
```

## State model

- The **store** maps each key to its current value and a per-key version
  counter. Version counters start at **1** for the first put of a key and
  increase by exactly 1 on every subsequent put of that same key. A key's
  counter never resets, even if the value written is identical to the
  previous value.
- The **replica** holds a cache: a mapping from key to the `(value,
  version)` pair the replica last fetched for that key. A cache entry is
  *fresh* when its version equals the store's current version for that
  key; otherwise (its version is lower) it is *stale*.
- The **controller** owns one `Store` and one `Replica` over that store.

## `store.py`

```python
class Store:
    def __init__(self) -> None: ...
    def put(self, key: str, value: str) -> int: ...
    def get(self, key: str) -> tuple[str, int] | None: ...
    def keys(self) -> list[str]: ...
```

### `__init__(self)`

Starts with empty state; every version counter starts fresh at the next
put.

### `put(self, key: str, value: str) -> int`

Writes `value` as the current value for `key` and returns the new version
number: 1 if `key` had never been put before, otherwise the previous
version plus 1. Overwriting a key with the same value still increments the
version.

### `get(self, key: str) -> tuple[str, int] | None`

Returns the current `(value, version)` pair for `key`, or `None` if the
key has never been put.

### `keys(self) -> list[str]`

Returns every stored key sorted lexicographically (ascending).

## `replica.py`

```python
class Replica:
    def __init__(self, store: Store) -> None: ...
    def read(self, key: str) -> tuple[str, int] | None: ...
    def invalidate(self, key: str) -> bool: ...
    def pending(self) -> list[str]: ...
```

### `__init__(self, store)`

Holds the given store and starts with an empty cache. Multiple replicas
may exist over the same store; their caches are independent.

### Read rule

A `read(key)` call resolves as follows:

1. **Miss**: `key` is not cached. Fetch the current pair from the store,
   cache it, and return it.
2. **Hit**: `key` is cached with a version equal to the store's current
   version for that key. Return the cached pair unchanged. The store is
   not consulted for a new value beyond this comparison, and the cache
   entry is left untouched.
3. **Stale hit**: `key` is cached with a version lower than the store's
   current version. This is still a successful read: fetch the current
   pair from the store, replace the cached entry with it, and return the
   fresh pair.

Reading a key the store has never seen returns `None`; such a read caches
nothing.

### `invalidate(self, key: str) -> bool`

Removes `key`'s cache entry if one is present and returns `True`;
returns `False` if there was no entry (including for keys the store has
never seen). Invalidation never touches the store.

### `pending(self) -> list[str]`

Returns every key whose cached version is lower than the store's current
version for that key — stale but still cached — sorted lexicographically.
Keys absent from the cache are not pending regardless of store contents;
keys whose cached version matches the store are not pending either.

Under the read rule alone the cache can only hold fresh entries or
nothing, so a non-empty `pending()` requires some actor to have advanced
the store without refreshing the cache — see `Controller.sync`.

Note: `pending()` compares against the store's *current* versions at the
moment it is called; calling it twice with no intervening writes returns
identical results.

## `controller.py`

```python
class Controller:
    def __init__(self, store: Store, replica: Replica) -> None: ...
    def sync(self, updates: dict[str, str]) -> dict: ...
    def audit(self) -> dict: ...
```

### `__init__(self, store, replica)`

Holds both modules. It does not copy or wrap them: puts made through the
controller are visible to the replica's staleness checks immediately.

### `sync(self, updates: dict[str, str]) -> dict`

Applies writes to the store only. Iterate `updates` in ascending
lexicographic key order; for each key call `store.put(key, value)`. The
replica is NOT consulted during `sync`: no reads, no invalidations. After
a sync the replica therefore holds whatever it held before — entries for
updated keys are now stale (or missing entirely). Returns exactly:

```python
{"puts": N}
```

where `N` is `len(updates)`, including when `updates` is empty (`{"puts":
0}`). Syncing an empty dict changes nothing and still returns `{"puts":
0}`.

Sorted-order application is observable only across separate syncs: a
second `sync` putting an already-present key increments its version
again even if the value is unchanged.

### `audit(self) -> dict`

Compares the replica's cache against the store's current state, then
repairs the replica. Two phases, in this order:

1. **Report phase.** Walk the store's keys in ascending lexicographic
   order. A key is **stale** if either (a) the replica has no cache entry
   for it while the store does, or (b) the replica's cached version for
   it differs from the store's current version. Every other store key
   counts toward **fresh** (cache present with equal version). Keys
   present in the cache but absent from the store cannot occur under this
   spec (there is no delete) and are ignored by the report.
2. **Repair phase.** For every key classified stale in phase 1, call
   `replica.read(key)` exactly once, which refills the cache from the
   store. Fresh keys are left untouched.

Returns exactly:

```python
{"stale": [...], "fresh": F}
```

where `stale` is the pre-repair stale list in ascending lexicographic
order and `F` is the pre-repair fresh count. The report describes the
state **before** any repair happened: a second `audit()` immediately
afterwards must return `{"stale": [], "fresh": F}` where F is now the
total number of store keys.

## Error behavior

No method defined here raises on any input described in this spec.
Behavior for argument types other than those shown in the signatures
(non-string keys/values, non-dict updates) is unspecified.

## Worked example — sync, audit, repair

```python
store = Store()
replica = Replica(store)
controller = Controller(store, replica)

store.put("b", "beta")                       # seed the store; cache empty
assert replica.read("b") == ("beta", 1)      # miss: fetches and caches b
assert controller.sync({"a": "x", "b": "y"}) == {"puts": 2}
# Store now: a=(x,1), b=(y,2). Cache: b=("beta",1) — stale; a uncached.

assert replica.pending() == ["b"]            # b cached at v1, store at v2
assert replica.read("a") == ("x", 1)         # miss: fetches and caches a

assert replica.pending() == ["b"]
assert replica.read("b") == ("y", 2)         # stale hit: refills to v2
assert replica.pending() == []

assert controller.audit() == {"stale": [], "fresh": 2}

controller.sync({"a": "z"})
assert controller.audit() == {"stale": ["a"], "fresh": 1}  # pre-repair report
assert replica.read("a") == ("z", 2)
assert controller.audit() == {"stale": [], "fresh": 2}     # repaired
```

Trace: the first `audit` finds both keys fresh because the explicit reads
above already refreshed everything. After `sync({"a": "z"})` the cache
holds `a` at version 1 while the store holds version 2, and `b` remains
cached at version 2 matching the store, so the stale list is exactly
`["a"]` with `b` counted fresh. The audit repairs `a` by reading it, so
the second audit reports nothing stale.
