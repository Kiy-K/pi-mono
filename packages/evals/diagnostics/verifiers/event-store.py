#!/usr/bin/env python3
"""External verifier for event-store. Every check derives only from SPEC text."""
import importlib.util
import io
import json
import os
import tempfile
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))

def load(name):
    spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

store_mod = load("store")
failures = []
total = 0

def check(name, fn):
    global total
    total += 1
    try:
        fn()
    except Exception as error:
        failures.append(f"{name}: {type(error).__name__}: {error}")

def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")

# Extended checks

def persistence_format_correct():
    """Disk file must contain one JSON line per key with string value."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "db.jsonl")
        s = store_mod.EventStore(path)
        s.apply([{"type": "set", "key": "a", "value": "1"}, {"type": "set", "key": "b", "value": "2"}])
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip()]
        assert_equal(len(lines), 2, "two lines on disk")
        objs = [json.loads(l) for l in lines]
        keys_on_disk = sorted(o["key"] for o in objs)
        assert_equal(keys_on_disk, ["a", "b"], "keys on disk match state")
        for o in objs:
            assert_equal(isinstance(o.get("value"), str), True, f"value for {o['key']} is string")

check("persistence writes one line per key with string value", persistence_format_correct)

def deleted_keys_not_on_disk():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "db.jsonl")
        s = store_mod.EventStore(path)
        s.apply([{"type": "set", "key": "a", "value": "1"}, {"type": "set", "key": "b", "value": "2"}])
        s.apply([{"type": "delete", "key": "a"}])
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip()]
        assert_equal(len(lines), 1, "one line after delete")
        assert_equal(json.loads(lines[0])["key"], "b", "remaining key is b")

check("deleted keys removed from disk", deleted_keys_not_on_disk)

def batch_stats_accuracy():
    with tempfile.TemporaryDirectory() as d:
        s = store_mod.EventStore(os.path.join(d, "db.jsonl"))
        stats = s.apply([
            {"type": "set", "key": "a", "value": "1"},
            {"type": "set", "key": "b", "value": "2"},
            {"type": "delete", "key": "a"},
            {"type": "bogus"},  # skipped
        ])
        assert_equal(stats, {"processed": 3, "set": 2, "deleted": 1}, "batch stats")

check("apply stats count correctly (skip unknown)", batch_stats_accuracy)

def verify_consistency_across_batches():
    with tempfile.TemporaryDirectory() as d:
        s = store_mod.EventStore(os.path.join(d, "db.jsonl"))
        s.apply([{"type": "set", "key": "x", "value": "1"}])
        s.apply([{"type": "set", "key": "y", "value": "2"}])
        s.apply([{"type": "delete", "key": "x"}])
        assert_equal(s.verify(), True, "consistent after 3 batches")
        assert_equal(s.get("x"), None, "x deleted")
        assert_equal(s.get("y"), "2", "y still present")

check("verify passes after multiple apply batches", verify_consistency_across_batches)

def keys_returns_sorted_after_mixed_ops():
    with tempfile.TemporaryDirectory() as d:
        s = store_mod.EventStore(os.path.join(d, "db.jsonl"))
        s.apply([
            {"type": "set", "key": "z", "value": "1"},
            {"type": "set", "key": "a", "value": "2"},
            {"type": "set", "key": "m", "value": "3"},
            {"type": "delete", "key": "z"},
        ])
        assert_equal(s.keys(), ["a", "m"], "sorted after delete")

check("keys sorted after mixed set/delete", keys_returns_sorted_after_mixed_ops)

def reload_preserves_state():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "db.jsonl")
        s1 = store_mod.EventStore(path)
        s1.apply([{"type": "set", "key": "k", "value": "v"}])
        s2 = store_mod.EventStore(path)
        assert_equal(s2.get("k"), "v", "reload preserves")
        assert_equal(s2.verify(), True, "reloaded store verifies")

check("new EventStore instance loads state from disk", reload_preserves_state)

def empty_store_verify():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "db.jsonl")
        s = store_mod.EventStore(path)
        assert_equal(s.verify(), True, "empty verifies")
        assert_equal(s.keys(), [], "empty keys")

check("empty store verifies and has no keys", empty_store_verify)

# Public suite must also pass
module = load("test_store")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(f"test_store.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)