#!/usr/bin/env python3
"""External verifier for log-rotate-v2: enforces every SPEC.md rule against the
clarified v2 contract. Independent derivation from SPEC only; no reference
implementation is consulted and no hidden expectations are added beyond the
spec text."""
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))


def load(name):
    spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rotation = load("rotation")
journal_mod = load("journal")

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


def assert_message(fn, expected, label):
    try:
        fn()
    except rotation.RotationError as error:
        assert_equal(str(error), expected, f"{label} message")
        return
    raise AssertionError(f"{label}: RotationError not raised")


def boundary_size_rotates():
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "journal.jsonl"
        path.write_text("x" * 100, encoding="utf-8")
        if not rotation.should_rotate(str(path), 100):
            raise AssertionError("size == max_bytes must rotate")


check("size equal to limit rotates", boundary_size_rotates)


def max_bytes_validation():
    assert_message(lambda: rotation.should_rotate("/nonexistent", 0), "max_bytes must be >= 1", "max_bytes 0")


check("max_bytes 0 rejected", max_bytes_validation)


def keep_validation():
    assert_message(lambda: rotation.rotate("/nonexistent", 0), "keep must be >= 1", "keep 0")


check("keep 0 rejected", keep_validation)


def suffix_chain_and_drop():
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "journal.jsonl"
        for suffix, content in [("", "active"), (".1", "one"), (".2", "two"), (".3", "three")]:
            base.parent.joinpath(base.name + suffix).write_text(content, encoding="utf-8")
        rotated = rotation.rotate(str(base), 2)
        assert_equal(rotated, ["journal.jsonl.1", "journal.jsonl.2"], "rotated list")
        assert_equal(base.with_name(base.name + ".1").read_text(), "active", "slot 1")
        assert_equal(base.with_name(base.name + ".2").read_text(), "one", "slot 2")
        if base.with_name(base.name + ".3").exists():
            raise AssertionError("slot with suffix > keep must be deleted")
        if base.exists():
            raise AssertionError("active journal must move to slot 1")


check("rotation shifts chain and drops beyond keep", suffix_chain_and_drop)


def rotate_missing_active_shifts_existing():
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "journal.jsonl"
        base.with_name(base.name + ".1").write_text("one", encoding="utf-8")
        rotated = rotation.rotate(str(base), 3)
        assert_equal(rotated, ["journal.jsonl.2"], "rotated list")
        assert_equal(base.with_name(base.name + ".2").read_text(), "one", "shifted slot")


check("rotate without active file still shifts", rotate_missing_active_shifts_existing)


def sparse_high_suffix_dropped():
    # SPEC: "Explicitly delete every existing path.j with j > keep." The suffix
    # set is sparse in general; a slot far above keep (here .5 with keep=2) must
    # be deleted even when no contiguous chain reaches it.
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "journal.jsonl"
        base.with_name(base.name + ".1").write_text("one", encoding="utf-8")
        base.with_name(base.name + ".5").write_text("far", encoding="utf-8")
        rotated = rotation.rotate(str(base), 2)
        # Missing active file: .1 shifts to .2, slot 1 stays empty, .5 is deleted.
        assert_equal(rotated, ["journal.jsonl.2"], "rotated list")
        assert_equal(base.with_name(base.name + ".2").read_text(), "one", "shifted slot")
        if base.with_name(base.name + ".5").exists():
            raise AssertionError("sparse slot .5 with suffix > keep must be deleted")


check("sparse high suffix dropped", sparse_high_suffix_dropped)


def append_with_rotation_validates():
    journal = journal_mod.Journal("/nonexistent/journal.jsonl")
    assert_message(lambda: rotation.append_with_rotation(journal, {}, 0, 3), "max_bytes must be >= 1", "max_bytes 0")
    assert_message(lambda: rotation.append_with_rotation(journal, {}, 10, 0), "keep must be >= 1", "keep 0")


check("append_with_rotation validates parameters", append_with_rotation_validates)


def append_rotates_at_boundary_and_returns_rotate_list():
    # SPEC: append_with_rotation rotates exactly when should_rotate fires
    # (size >= max_bytes) and "returns the same list rotate returned".
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "journal.jsonl"
        base.with_name(base.name + ".1").write_text("old-1", encoding="utf-8")
        journal = journal_mod.Journal(str(base))
        journal.append({"n": 1})
        boundary = journal.size_bytes()
        returned = rotation.append_with_rotation(journal, {"n": 2}, boundary, 3)
        if returned != ["journal.jsonl.1", "journal.jsonl.2"]:
            raise AssertionError(f"append must return exactly rotate's list, got {returned}")
        if not pathlib.Path(str(base) + ".2").exists():
            raise AssertionError("chain shift must reach slot 2 after boundary append")


check("append rotates at boundary and returns rotate list", append_rotates_at_boundary_and_returns_rotate_list)


def append_preserves_entries_across_rotations():
    with tempfile.TemporaryDirectory() as tmp:
        journal = journal_mod.Journal(str(pathlib.Path(tmp) / "journal.jsonl"))
        for n in range(1, 4):
            rotation.append_with_rotation(journal, {"n": n}, 10, 2)
        entries = journal.read_all()
        if entries != [{"n": 3}]:
            raise AssertionError(f"active journal must hold only the last entry, got {entries}")
        rotated_first = journal_mod.Journal(str(journal.path) + ".1").read_all()
        assert_equal(rotated_first, [{"n": 1}, {"n": 2}], "slot 1 contents")


check("entries survive rotation", append_preserves_entries_across_rotations)


def rotation_error_is_value_error():
    if not issubclass(rotation.RotationError, ValueError):
        raise AssertionError("RotationError must subclass ValueError")


check("RotationError subclasses ValueError", rotation_error_is_value_error)


# Public suite must also pass.
module = load("test_rotation")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, traceback in result.failures + result.errors:
    failures.append(f"test_rotation.{case.id().split('.')[-1]}: {traceback.splitlines()[-1] if traceback else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)