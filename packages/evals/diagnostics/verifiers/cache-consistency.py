#!/usr/bin/env python3
"""External verifier for cache-consistency. Every check derives only from SPEC text."""
import io
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))

failures = []
total = 0


def load(name):
    return load_module(root, name)


store_mod = load("store")
replica_mod = load("replica")
controller_mod = load("controller")

Store = store_mod.Store
Replica = replica_mod.Replica
Controller = controller_mod.Controller


def check(name, fn):
    global total
    total += 1
    try:
        fn()
    except Exception as error:  # noqa: BLE001 - verifier reports all failures
        failures.append(f"{name}: {type(error).__name__}: {error}")


def assert_equal(actual, expected, label=None):
    if actual != expected:
        where = f" ({label})" if label else ""
        raise AssertionError(f"{where}: expected {expected!r}, got {actual!r}".lstrip())


# --- Store: version monotonicity and sorted keys -------------------------


def store_version_monotonic_interleaved():
    """Per-key counters are independent, start at 1, increment on every put,
    even when the value is unchanged or keys interleave."""
    s = Store()
    a_versions = [s.put("a", f"v{i}") for i in range(5)]
    b_versions = [s.put("b", "const") for _ in range(3)]
    assert_equal(a_versions, [1, 2, 3, 4, 5], "per-key versions from 1")
    assert_equal(b_versions, [1, 2, 3], "unchanged value still bumps version")
    assert_equal(s.put("a", "final"), 6, "interleaving does not disturb counters")
    assert_equal(s.put("b", "const"), 4, "identical write still increments")
    # Fresh store restarts counters at 1.
    assert_equal(Store().put("a", "x"), 1, "new Store starts fresh")


def store_get_and_sorted_keys():
    s = Store()
    assert_equal(s.get("nope"), None, "absent key reads as None")
    assert_equal(s.keys(), [], "empty store has no keys")
    s.put("zeta", "1")
    s.put("alpha", "2")
    s.put("mid", "3")
    s.put("alpha", "2b")
    assert_equal(s.keys(), ["alpha", "mid", "zeta"], "keys sorted lexicographically")
    assert_equal(s.get("alpha"), ("2b", 2), "get returns latest value and version")
    assert_equal(s.get("mid"), ("3", 1), "untouched key keeps version 1")


# --- Replica: miss/hit/stale-hit matrix -----------------------------------


def replica_read_matrix():
    """Craft states via direct puts + sync; probe miss, hit, stale hit."""
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    assert_equal(r.read("ghost"), None, "reading unknown key returns None")
    s.put("k", "v1")           # v1 in store, nothing cached
    assert_equal(r.read("k"), ("v1", 1), "miss fetches and caches")
    c.sync({"other": "o"})     # unrelated write must not disturb k's cache
    assert_equal(r.read("k"), ("v1", 1), "hit returns cached pair untouched")
    s.put("k", "v2")           # store now ahead of cache
    assert_equal(r.pending(), ["k"], "stale entry is pending")
    assert_equal(r.read("k"), ("v2", 2), "stale hit refills to fresh pair")
    assert_equal(r.pending(), [], "refilled entry no longer pending")
    assert_equal(r.read("k"), ("v2", 2), "entry is a plain hit again")
    # Same-value overwrite still makes the cache stale.
    s.put("same", "x")
    r.read("same")
    s.put("same", "x")
    assert_equal(r.pending(), ["same"], "version bump counts as staleness")
    assert_equal(r.read("same"), ("x", 2), "stale hit returns bumped version")


def replica_invalidate_semantics():
    s = Store()
    r = Replica(s)
    assert_equal(r.invalidate("never"), False, "invalidating unknown key is False")
    s.put("k", "v")
    r.read("k")
    assert_equal(r.invalidate("k"), True, "invalidating cached key is True")
    assert_equal(r.invalidate("k"), False, "second invalidate finds nothing")
    assert_equal(r.read("k"), ("v", 1), "post-invalidate read is a miss that refetches")
    # Invalidation never touches the store.
    assert_equal(s.get("k"), ("v", 1), "invalidate left store intact")
    # Two replicas over one store have independent caches.
    r2 = Replica(s)
    r2.read("k")
    s.put("k", "v2")
    assert_equal(r2.read("k"), ("v2", 2), "second replica sees fresh state")
    assert_equal(r.invalidate("k"), True, "first replica still holds its old entry")


def replica_pending_exact_contents():
    """pending() lists only cached-and-behind keys, sorted; misses excluded."""
    s = Store()
    r = Replica(s)
    assert_equal(r.pending(), [], "empty world, nothing pending")
    s.put("b", "1")
    s.put("c", "1")
    assert_equal(r.pending(), [], "uncached store keys are not pending")
    r.read("c")
    r.read("b")
    assert_equal(r.pending(), [], "fresh entries are not pending")
    s.put("c", "2")
    s.put("a", "1")
    # Cache: b@1 fresh, c@1 stale. a uncached (not pending despite being new).
    assert_equal(r.pending(), ["c"], "only stale-but-cached key listed")
    s.put("b", "9")
    assert_equal(r.pending(), ["b", "c"], "multiple stale keys sort ascending")
    r.invalidate("c")
    assert_equal(r.pending(), ["b"], "invalidated key leaves pending (not cached)")
    r.read("b")
    assert_equal(r.pending(), [], "refreshed key leaves pending")


# --- Controller: sync stats -----------------------------------------------


def sync_stats_exact():
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    assert_equal(c.sync({}), {"puts": 0}, "empty sync stats")
    assert_equal(c.sync({"x": "1"}), {"puts": 1}, "single put stats")
    assert_equal(c.sync({"y": "2", "x": "2"}), {"puts": 2}, "count equals len(updates)")
    assert_equal(c.audit(), {"stale": ["x", "y"], "fresh": 0}, "pre-repair: both writes uncached")
    assert_equal(c.audit(), {"stale": [], "fresh": 2}, "post-repair second audit clean")


def sync_leaves_replica_untouched():
    """sync must not read or invalidate through the replica."""
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    s.put("keep", "seed")
    r.read("keep")             # miss: caches (seed, 1)
    c.sync({"keep": "new"})
    # If sync had invalidated, this would be a miss refetch; if it had read,
    # the cache would already be fresh. Either way pending() must show it.
    assert_equal(r.pending(), ["keep"], "sync advanced store without refreshing cache")
    assert_equal(r.read("keep"), ("new", 2), "cache still held the pre-sync entry")


def sync_applies_all_writes():
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    updates = {f"k{i:02d}": str(i) for i in range(10)}
    assert_equal(c.sync(updates), {"puts": 10}, "stats count every update")
    assert_equal(sorted(s.keys()), sorted(updates), "every key present after sync")
    for k, v in updates.items():
        value, version = s.get(k)
        assert_equal((value, version == 1), (v, True), f"first put of {k} is version 1")


# --- Controller: audit report-then-repair --------------------------------


def audit_reports_pre_repair_state():
    """Single audit call: report describes pre-repair cache, then repairs."""
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    s.put("a", "1")
    s.put("b", "1")
    s.put("c", "1")
    r.read("b")                # b fresh; a, c uncached -> stale
    report = c.audit()
    assert_equal(report, {"stale": ["a", "c"], "fresh": 1}, "pre-repair report exact")
    # Repair happened inside the same call: everything readable and fresh now.
    assert_equal(r.read("a"), ("1", 1), "repair made a a plain hit")
    assert_equal(r.read("c"), ("1", 1), "repair made c a plain hit")
    assert_equal(c.audit(), {"stale": [], "fresh": 3}, "second audit fully clean")


def audit_second_audit_invariant():
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    for k in "abcdef":
        s.put(k, k)
    c.sync({"g": "g"})
    first = c.audit()
    assert_equal(first, {"stale": list("abcdefg"), "fresh": 0}, "all missing counted stale")
    second = c.audit()
    assert_equal(second, {"stale": [], "fresh": 7}, "post-audit invariant")
    third = c.audit()
    assert_equal(third, {"stale": [], "fresh": 7}, "idempotent once repaired")


def audit_mixed_missing_stale_fresh():
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    for k in ("m1", "m2"):
        s.put(k, "v")          # will stay uncached -> missing-stale
    r.read("f1")               # stays fresh
    s.put("f1", "ignored-bump")
    r.read("f1")               # refresh after bump: fresh again
    s.put("s1", "old")
    r.read("s1")               # cached at v1
    s.put("s1", "new")         # store at v2: version-stale
    report = c.audit()
    assert_equal(report["stale"], ["m1", "m2", "s1"], "missing and version-stale both listed")
    assert_equal(report["fresh"], 1, "exactly f1 was fresh")
    assert_equal(c.audit(), {"stale": [], "fresh": 4}, "repaired to full freshness")


def audit_empty_world():
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    assert_equal(c.audit(), {"stale": [], "fresh": 0}, "audit of empty store and cache")


def audit_does_not_touch_fresh_entries():
    """Repair phase must not rewrite fresh entries (observable via versions)."""
    s = Store()
    r = Replica(s)
    c = Controller(s, r)
    s.put("k", "v")
    r.read("k")                       # cache at v1
    s.put("other", "o")               # make something stale so repair runs
    assert_equal(c.audit(), {"stale": ["other"], "fresh": 1}, "report before repair")
    assert_equal(r.read("k"), ("v", 1), "k still cached at its original version")


# --- Cross-module integration --------------------------------------------


def interleaved_multi_sync_scenario():
    """Longer sequence mixing direct puts, syncs, invalidations, audits."""
    s = Store()
    r = Replica(s)
    c = Controller(s, r)

    c.sync({"a": "1", "b": "1", "c": "1"})
    r.read("b")
    assert_equal(c.audit(), {"stale": ["a", "c"], "fresh": 1})
    assert_equal(c.audit(), {"stale": [], "fresh": 3})

    s.put("a", "2")
    r.invalidate("c")
    assert_equal(r.pending(), ["a"], "a is cached-and-stale after direct put")
    assert_equal(c.audit(), {"stale": ["a", "c"], "fresh": 1})
    assert_equal(c.audit(), {"stale": [], "fresh": 3})

    c.sync({"b": "2", "d": "1"})
    assert_equal(r.pending(), ["b"], "only b is cached-and-stale after sync")
    assert_equal(c.audit(), {"stale": ["b", "d"], "fresh": 2})
    assert_equal(c.audit(), {"stale": [], "fresh": 4})
    assert_equal(s.get("b"), ("2", 2), "second sync bumped b's version")


# --- Run every named check --------------------------------------------------

import inspect as _inspect
from _common import load_module

CHECKS = [
    store_version_monotonic_interleaved,
    store_get_and_sorted_keys,
    replica_read_matrix,
    replica_invalidate_semantics,
    replica_pending_exact_contents,
    sync_stats_exact,
    sync_leaves_replica_untouched,
    sync_applies_all_writes,
    audit_reports_pre_repair_state,
    audit_second_audit_invariant,
    audit_mixed_missing_stale_fresh,
    audit_empty_world,
    audit_does_not_touch_fresh_entries,
    interleaved_multi_sync_scenario,
]

for _fn in CHECKS:
    check(_fn.__name__, _fn)



# --- Public suite rerun ----------------------------------------------------

module = load("test_controller")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(
        f"test_controller.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}"
    )

print(__import__("json").dumps({"passed": not failures, "tests": total, "failures": failures}))
sys.exit(0 if not failures else 1)
