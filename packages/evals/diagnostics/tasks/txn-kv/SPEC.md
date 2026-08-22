# Transactional KV Store Specification

All behavior in this specification is normative. A `TxnKV` is an in-memory
key-value store (string keys, string values) with multi-transaction snapshot
isolation, savepoints, and atomic commit.

## State model

The store holds:

- **Committed state**: the authoritative mapping from key to value.
- **Open transactions**: a LIFO stack. Each transaction consists of:
  - `id`: a positive int, assigned monotonically from 1 across the lifetime
    of the store. Ids are never reused.
  - `snapshot`: an exact copy of the committed state taken at `begin()` time.
    The snapshot never changes afterwards.
  - `ops`: the ordered list of staged operations. Each staged operation is
    either a set of `(key, value)` or a delete of `(key,)`. New ops are
    appended at the end.
  - `savepoints`: a mapping from savepoint name to the length of `ops` at the
    moment the savepoint was created, plus the creation order.
  - a per-transaction savepoint counter used to generate savepoint names.

## Operation routing

Every `set`, `get`, and `delete` call routes to the **innermost open
transaction**: the transaction most recently begun that is still open (not
yet committed or rolled back). If no transaction is open, the call acts
directly on committed state ("direct mode"). While an inner transaction is
open, `set`/`get`/`delete` are never applied to an outer transaction.

`begin`, `commit`, `rollback`, `savepoint`, and `rollback_to` address
transactions explicitly by id, so they work regardless of which transaction
is innermost.

## Direct-mode operations

With no open transaction:

- `set(key, value)` writes through to committed state.
- `get(key)` returns the committed value for `key`, or `None` if absent.
- `delete(key)` removes `key` from committed state and returns `True` if it
  was present, `False` otherwise.

## `__init__(self)`

Starts with empty committed state, no open transactions, and the transaction
id counter at 1.

## `begin(self) -> int`

Creates a transaction: snapshots the committed state as it is at that exact
moment, starts with an empty op list and reset savepoint state, pushes it
onto the open stack, and returns its id. Ids increase monotonically from 1
and are never reused, including after the transaction finishes. Beginning a
transaction while others are open is allowed and is the normal way to obtain
concurrent transactions.

## Read rule (isolation)

A `get(key)` routed to an open transaction T resolves the key as follows:

1. Scan T's own staged ops newest-first. The first staged op for `key`
   decides: a staged set yields its value; a staged delete yields "absent".
2. Otherwise fall back to T's snapshot: the value `key` had at `begin()`
   time, or `None` if absent.

Committed state itself is consulted only through the snapshot. Consequences,
all normative:

- **Read-your-writes**: T observes its own staged writes immediately.
- T never observes staged ops of other open transactions.
- T never observes commits made by other transactions after T began
  (snapshot stability), even if those commits changed keys T can read.

## Staging writes

- `set(key, value)` routed to an open transaction T appends a set op for
  `(key, value)` to `T.ops` and returns `None`.
- `delete(key)` routed to T first evaluates whether `key` is **visible** to
  T (i.e., `get(key)` would not return `None` at that moment), then appends
  a delete op for `key` to `T.ops`, and returns the visibility result:
  `True` if the key was visible, `False` otherwise. Deleting an invisible
  key still stages the tombstone normally and counts in every stat below.
- A staged set followed by a staged delete of the same key leaves the key
  absent in T's read view; a staged delete followed by a staged set leaves
  it present with the new value.

## `commit(self, txn: int) -> dict`

`txn` must be the id of a currently open transaction, otherwise `KeyError`.
Apply the transaction's staged ops to committed state in application order:
each staged set writes its value; each staged delete removes the key from
committed state if present (deleting an absent key is a no-op). Because ops
apply in order, the last staged op for a key wins ("last-write-wins per
key"). The transaction is then finished: it is removed from the open stack
and its ops and savepoints are discarded. Returns exactly:

```python
{"committed": N}
```

where `N` is the number of staged ops applied. Both sets and deletes count,
including deletes of keys that were absent from committed state.

## `rollback(self, txn: int) -> dict`

`txn` must be the id of a currently open transaction, otherwise `KeyError`.
Discards all staged ops and savepoints and finishes the transaction (removed
from the open stack) without touching committed state. Returns exactly:

```python
{"rolled_back": N}
```

where `N` is the number of staged ops discarded.

## `savepoint(self, txn: int) -> str`

`txn` must be the id of a currently open transaction, otherwise `KeyError`.
Creates a savepoint inside that transaction named `"sp<C>"`, where `<C>` is
the transaction's savepoint counter. The counter starts at 1 and increments
by 1 on every `savepoint` call in that transaction, regardless of any
rollbacks — names are therefore never reused within a transaction. The
savepoint records the current length of the op list. Different transactions
have independent counters (two transactions both name their first savepoint
`"sp1"`). Returns the name.

## `rollback_to(self, txn: int, sp: str) -> dict`

`txn` must be the id of a currently open transaction and `sp` must be the
name of a savepoint of that same transaction; otherwise `KeyError` (this
covers names that were never created, names discarded below, and names
belonging to a different transaction). Removes every staged op recorded
after the savepoint was created — that is, truncates the op list back to the
length the savepoint recorded; the number of removed ops may be 0. Every
savepoint of that transaction **created after** `sp` (by creation order, even
if it recorded the same op-list length) is discarded and its name becomes
unknown. `sp` itself remains valid and may be rolled back to again later.
Savepoints created before `sp` are unaffected. Committed state is never
touched. Returns exactly:

```python
{"undone": K}
```

where `K` is the number of staged ops removed.

## Finishing order

Transactions may finish in any order: an outer transaction may commit or
roll back while an inner one is open. After a transaction finishes, calls
route to the new innermost open transaction, or to direct mode if none
remain. A finished transaction id is invalid forever: `commit`, `rollback`,
`savepoint`, and `rollback_to` on it raise `KeyError`.

## Error behavior

`KeyError` is raised when:

- `commit` or `rollback` receives an id that was never assigned or belongs
  to an already-finished transaction.
- `savepoint` receives an unknown or finished transaction id.
- `rollback_to` receives an unknown or finished transaction id, or a
  savepoint name that is unknown for that transaction.

Behavior for argument types other than those shown in the signatures
(non-int transaction ids, non-string keys/values/savepoint names) is
unspecified.

## Worked example 1 — read-your-writes, snapshot isolation, merge order

```python
kv = TxnKV()
t1 = kv.begin()          # -> 1
kv.get("a")              # -> None (store empty)
kv.set("a", "v1")        # staged in t1
kv.get("a")              # -> "v1" (read-your-writes)

t2 = kv.begin()          # -> 2; snapshot {} ("v1" is not committed)
kv.set("a", "v2")        # staged in t2 (innermost)
kv.commit(t2)            # -> {"committed": 1}; committed: {"a": "v2"}
kv.get("a")              # -> "v1" — t1 is innermost again: it sees its own
                         #    staged write; t2's later commit is INVISIBLE
kv.delete("a")           # -> True ("a" is visible via t1's staged set)
kv.commit(t1)            # -> {"committed": 2} (one set + one delete)
kv.get("a")              # -> None (t1's ops applied after t2's: last-write-wins)
```

## Worked example 2 — savepoints

```python
kv = TxnKV()
t = kv.begin()           # -> 1
kv.set("x", "1")         # staged op 1
sp1 = kv.savepoint(t)    # -> "sp1"
kv.set("y", "2")         # staged op 2
sp2 = kv.savepoint(t)    # -> "sp2"
kv.set("z", "3")         # staged op 3
kv.rollback_to(t, sp2)   # -> {"undone": 1} (undoes op 3 only)
kv.get("y")              # -> "2"
kv.rollback_to(t, sp1)   # -> {"undone": 1} (undoes op 2; discards sp2)
kv.get("x")              # -> "1"
kv.get("y")              # -> None
kv.rollback_to(t, sp2)   # raises KeyError (sp2 was discarded)
kv.set("w", "4")
kv.rollback_to(t, sp1)   # -> {"undone": 1} (sp1 is still valid)
sp3 = kv.savepoint(t)    # -> "sp3" (counter kept incrementing; "sp2" is gone)
kv.commit(t)             # -> {"committed": 1} (only x="1" remains staged)
kv.get("w")              # -> None
```

## Worked example 3 — tombstones and conflict-free merge

```python
kv = TxnKV()
kv.set("live", "1")      # direct mode: committed {"live": "1"}
t = kv.begin()           # -> 1
kv.delete("live")        # -> True (visible in snapshot; tombstone staged)
kv.delete("ghost")       # -> False (invisible, but tombstone still staged)
t2 = kv.begin()          # -> 2; snapshot {"live": "1"}
kv.set("other", "2")     # staged in t2
kv.commit(t)             # -> {"committed": 2} (both deletes count)
kv.commit(t2)            # -> {"committed": 1}; committed: {"other": "2"}
kv.get("live")           # -> None (committed delete applied)
kv.get("ghost")          # -> None (deleting an absent key was a no-op)
kv.get("other")          # -> "2"
```
