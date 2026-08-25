#!/usr/bin/env python3
"""External verifier for txn-kv. Every check derives only from SPEC text."""
import io
import json
import pathlib
import sys
import unittest
from _common import load_module

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))


def load(name):
    return load_module(root, name)


kv_mod = load("kv")
failures = []
total = 0


def check(name, fn):
    global total
    total += 1
    try:
        fn()
    except Exception as error:
        failures.append(f"{name}: {type(error).__name__}: {error}")



def assert_equal(actual, expected, label=None):
    if actual != expected:
        where = f" ({label})" if label else ""
        raise AssertionError(f"{where}: expected {expected!r}, got {actual!r}".lstrip())


def expect_keyerror(label, fn):
    try:
        fn()
        raise AssertionError(f"{label} must raise KeyError")
    except KeyError:
        pass


TxnKV = kv_mod.TxnKV

# --- Visibility matrix across interleaved transactions -------------------


def visibility_matrix():
    """get() result for each pairing: own stage yes, other open txn's stage
    no, pre-begin commit yes, post-begin commit no."""
    kv = TxnKV()
    t1 = kv.begin()
    kv.set("a", "t1")            # staged in t1; not committed
    t2 = kv.begin()              # snapshot of committed state: {} -> no "a"
    # innermost is t2 now
    assert_equal(kv.get("a"), None, "t2 must not see t1's uncommitted set")
    kv.set("b", "t2")            # staged in t2
    assert_equal(kv.get("b"), "t2", "t2 reads its own staged write")
    kv.commit(t1)                # commits a="t1" AFTER t2 began
    assert_equal(kv.get("a"), None, "t2 must not see t1's later commit")
    assert_equal(kv.get("b"), "t2", "own staged write still visible after foreign commit")
    kv.commit(t2)
    assert_equal(kv.get("a"), "t1", "committed state merged from both txns")
    assert_equal(kv.get("b"), "t2", "committed state merged from both txns")


def innermost_routing():
    """set/get/delete always hit the innermost open transaction while one exists."""
    kv = TxnKV()
    t1 = kv.begin()
    kv.set("k", "outer-stage")   # routes to t1
    t2 = kv.begin()
    kv.set("k", "inner-stage")   # routes to t2 (innermost); t1's op untouched
    assert_equal(kv.get("k"), "inner-stage", "innermost read")
    assert_equal(kv.commit(t1), {"committed": 1}, "t1 kept exactly its own op")
    assert_equal(kv.get("k"), "inner-stage", "innermost view unaffected by outer commit")
    assert_equal(kv.commit(t2), {"committed": 1}, "t2 kept exactly its own op")
    assert_equal(kv.get("k"), "inner-stage", "last-write-wins merge order")


def routing_returns_after_finish():
    """After the innermost transaction finishes, ops route to the next open one."""
    kv = TxnKV()
    t1 = kv.begin()
    t2 = kv.begin()
    t3 = kv.begin()
    kv.set("x", "t3")            # t3 innermost
    kv.rollback(t3)
    kv.set("x", "t2")            # now routes to t2
    kv.commit(t2)
    kv.set("x", "t1")            # routes to t1
    assert_equal(kv.get("x"), "t1", "routing follows remaining open transaction")
    kv.commit(t1)
    assert_equal(kv.get("x"), "t1", "last-write-wins across ordered commits")


# --- Snapshot stability ----------------------------------------------------


def snapshot_frozen_at_begin():
    """A mid-transaction foreign commit must not change any read of an open txn."""
    kv = TxnKV()
    kv.set("stable", "v0")
    kv.set("gone", "g0")
    t = kv.begin()               # snapshot {"stable": "v0", "gone": "g0"}
    kv.delete("gone")            # stage tombstone on visible key
    other = kv.begin()
    kv.set("fresh", "f")         # routes to 'other' (innermost)
    kv.set("stable", "v1")
    kv.commit(other)             # committed: stable=v1, fresh=f, gone=g0
    # Innermost is t again:
    assert_equal(kv.get("stable"), "v0", "snapshot value despite newer commit")
    assert_equal(kv.get("fresh"), None, "post-begin commit invisible")
    assert_equal(kv.get("gone"), None, "own staged tombstone wins over snapshot")
    assert_equal(kv.delete("stable"), True, "visibility via snapshot despite foreign overwrite")
    assert_equal(kv.commit(t), {"committed": 2}, "delete + set counted")
    assert_equal(kv.get("stable"), None, "later commit applies last-write-wins")


# --- Savepoint semantics -----------------------------------------------------


def savepoint_undo_counts():
    kv = TxnKV()
    t = kv.begin()
    sp0 = kv.savepoint(t)
    kv.set("a", "1")
    kv.set("b", "2")
    sp1 = kv.savepoint(t)
    kv.delete("a")
    kv.set("c", "3")
    assert_equal(kv.rollback_to(t, sp1), {"undone": 2}, "two ops staged after sp1")
    assert_equal(kv.get("a"), "1", "a restored to pre-sp1 state")
    assert_equal(kv.get("c"), None, "c undone")
    assert_equal(kv.rollback_to(t, sp0), {"undone": 2}, "two ops staged before sp1")
    assert_equal(kv.get("a"), None, "a back to snapshot state")
    assert_equal(kv.get("b"), None, "b back to snapshot state")


def savepoint_discard_semantics():
    kv = TxnKV()
    t = kv.begin()
    kv.set("x", "1")
    sp1 = kv.savepoint(t)
    kv.set("y", "2")
    sp2 = kv.savepoint(t)
    kv.set("z", "3")
    assert_equal(kv.rollback_to(t, sp2), {"undone": 1}, "undo z")
    assert_equal(kv.rollback_to(t, sp2), {"undone": 0}, "sp2 remains valid after undoing to itself")
    assert_equal(kv.rollback_to(t, sp1), {"undone": 1}, "undo y; discards sp2 (created later)")
    expect_keyerror("discarded sp2", lambda: kv.rollback_to(t, sp2))
    assert_equal(kv.get("y"), None)
    assert_equal(kv.get("z"), None)
    assert_equal(kv.get("x"), "1")
    assert_equal(kv.savepoint(t), "sp3", "counter never reuses names")
    assert_equal(kv.commit(t), {"committed": 1}, "only x remains staged")


def savepoint_counter_independent_per_txn():
    kv = TxnKV()
    t1 = kv.begin()
    t2 = kv.begin()
    assert_equal(kv.savepoint(t1), "sp1")
    assert_equal(kv.savepoint(t2), "sp1")
    assert_equal(kv.savepoint(t1), "sp2")
    kv.rollback_to(t1, "sp1")
    assert_equal(kv.savepoint(t1), "sp3", "counter survives rollback_to")


def savepoints_are_transaction_local():
    kv = TxnKV()
    t1 = kv.begin()
    t2 = kv.begin()
    kv.savepoint(t1)
    expect_keyerror("foreign savepoint name", lambda: kv.rollback_to(t2, "sp1"))
    kv.rollback(t2)
    kv.rollback(t1)


def rollback_to_zero_ops():
    kv = TxnKV()
    t = kv.begin()
    sp = kv.savepoint(t)
    assert_equal(kv.rollback_to(t, sp), {"undone": 0}, "no ops between create and undo")
    assert_equal(kv.rollback_to(t, sp), {"undone": 0}, "sp stays valid after zero-op undo")


def full_rollback_kills_savepoints():
    kv = TxnKV()
    t = kv.begin()
    kv.savepoint(t)
    assert_equal(kv.rollback(t), {"rolled_back": 0})
    expect_keyerror("savepoint dead after full rollback", lambda: kv.rollback_to(t, "sp1"))


# --- Tombstone semantics -----------------------------------------------------


def tombstone_visibility_and_commit():
    kv = TxnKV()
    kv.set("live", "1")
    t = kv.begin()
    assert_equal(kv.delete("live"), True, "visible in snapshot")
    assert_equal(kv.get("live"), None, "staged tombstone hides key immediately")
    assert_equal(kv.delete("ghost"), False, "invisible key delete returns False but stages")
    assert_equal(kv.delete("ghost2"), False, "second invisible delete also stages")
    assert_equal(kv.commit(t), {"committed": 3}, "all three deletes count")
    assert_equal(kv.get("live"), None, "committed tombstone removes key")
    assert_equal(kv.get("ghost"), None, "delete of absent key was a no-op")


def delete_then_set_then_delete():
    kv = TxnKV()
    kv.set("k", "v")
    t = kv.begin()
    kv.delete("k")
    kv.set("k", "v2")
    assert_equal(kv.get("k"), "v2", "delete then set leaves present")
    kv.delete("k")
    assert_equal(kv.get("k"), None, "set then delete leaves absent")
    assert_equal(kv.commit(t), {"committed": 3}, "each staged op counts once")
    assert_equal(kv.get("k"), None, "final op was a delete")


# --- Transaction id monotonicity ---------------------------------------------


def txn_ids_monotonic_never_reused():
    kv = TxnKV()
    ids = [kv.begin() for _ in range(3)]
    assert_equal(ids, [1, 2, 3], "ids start at 1, increment by 1")
    kv.commit(ids[2])
    kv.rollback(ids[1])
    more = [kv.begin(), kv.begin()]
    assert_equal(more, [4, 5], "finished ids are never reused")


# --- Exception types -----------------------------------------------------------


def exception_types():
    kv = TxnKV()
    t = kv.begin()
    kv.commit(t)
    expect_keyerror("double commit", lambda: kv.commit(t))
    expect_keyerror("unknown txn commit", lambda: kv.commit(12345))
    expect_keyerror("rollback unknown txn", lambda: kv.rollback(12345))
    expect_keyerror("savepoint unknown txn", lambda: kv.savepoint(12345))
    expect_keyerror("rollback_to unknown txn", lambda: kv.rollback_to(12345, "sp1"))
    t2 = kv.begin()
    expect_keyerror("unknown savepoint name", lambda: kv.rollback_to(t2, "never-created"))
    kv.savepoint(t2)
    kv.rollback(t2)
    expect_keyerror("double rollback", lambda: kv.rollback(t2))
    expect_keyerror("savepoint on finished txn", lambda: kv.savepoint(t2))
    expect_keyerror("rollback_to on finished txn", lambda: kv.rollback_to(t2, "sp1"))


# --- Stats dict exact values ------------------------------------------------------


def stats_exact_values():
    kv = TxnKV()
    t = kv.begin()
    kv.set("a", "1")
    kv.set("a", "2")             # duplicate-key sets each count
    kv.delete("absent")          # invisible delete counts too
    assert_equal(kv.rollback(t), {"rolled_back": 3}, "rollback counts every staged op")
    assert_equal(kv.get("a"), None, "rollback touched nothing")

    t2 = kv.begin()
    kv.set("a", "1")
    kv.set("a", "2")
    kv.delete("absent")
    assert_equal(kv.commit(t2), {"committed": 3}, "commit counts every staged op")
    assert_equal(kv.get("a"), "2", "last write wins")


def empty_commit_and_rollback():
    kv = TxnKV()
    t = kv.begin()
    assert_equal(kv.commit(t), {"committed": 0}, "empty txn commits zero changes")
    t2 = kv.begin()
    assert_equal(kv.rollback(t2), {"rolled_back": 0}, "empty rollback discards zero ops")

check("visibility matrix across interleaved txns", visibility_matrix)
check("innermost transaction routing", innermost_routing)
check("routing returns after finish", routing_returns_after_finish)
check("savepoint discard semantics", savepoint_discard_semantics)
check("snapshot frozen at begin across foreign commit", snapshot_frozen_at_begin)
check("savepoint undo counts", savepoint_undo_counts)
check("savepoint counters independent per txn", savepoint_counter_independent_per_txn)
check("savepoints are transaction-local", savepoints_are_transaction_local)
check("rollback_to with zero ops", rollback_to_zero_ops)
check("full rollback kills savepoints", full_rollback_kills_savepoints)
check("tombstone visibility and commit", tombstone_visibility_and_commit)
check("delete/set/delete op ordering", delete_then_set_then_delete)
check("txn ids monotonic and never reused", txn_ids_monotonic_never_reused)
check("exact exception types", exception_types)
check("stats dicts exact values", stats_exact_values)
check("empty commit and rollback", empty_commit_and_rollback)

# Public suite must also pass
module = load("test_kv")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(
        f"test_kv.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}"
    )

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)
