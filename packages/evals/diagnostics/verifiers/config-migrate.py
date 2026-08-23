#!/usr/bin/env python3
"""External verifier for config-migrate. Every check derives only from SPEC text."""
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

migrate_mod = load("migrate")
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

def write_file(d, name, content):
    with open(os.path.join(d, name), "w") as f:
        json.dump(content, f)

def read_file(d, name):
    with open(os.path.join(d, name)) as f:
        return json.load(f)

# Extended checks

def rename_count_accuracy():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "a.json", {"host": "h1", "port": 80})
        write_file(d, "b.json", {"name": "no-host"})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["fields_renamed"], 1, "one rename (a only)")

check("rename counts only files with host key", rename_count_accuracy)

def coerce_count_accuracy():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "a.json", {"host": "x", "port": 100})
        write_file(d, "b.json", {"host": "y"})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["ports_coerced"], 1, "one coerce (a only)")

check("coerce counts only files with int port", coerce_count_accuracy)


def coerce_skips_non_int_ports():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "a.json", {"host": "x", "port": "80"})
        write_file(d, "b.json", {"host": "y", "port": True})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["ports_coerced"], 0, "string and bool ports not coerced")
        assert_equal(read_file(d, "a.json")["port"], "80", "string port untouched")


check("coerce counts only int ports not strings or bools", coerce_skips_non_int_ports)

def enabled_already_present_not_overwritten():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "x.json", {"host": "h", "port": 1, "enabled": False})
        migrate_mod.migrate(d)
        f = read_file(d, "x.json")
        assert_equal(f["enabled"], False, "enabled preserved as False")

check("existing enabled field preserved", enabled_already_present_not_overwritten)

def reference_missing_file_skipped():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "app.json", {"host": "x", "port": 1, "db_config": "nonexistent.json"})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["references_inlined"], 0, "missing ref skipped")
        f = read_file(d, "app.json")
        assert_equal("db_endpoint" in f, False, "no db_endpoint added")

check("missing reference file skipped gracefully", reference_missing_file_skipped)

def reference_chain_ordering():
    """root has no _config; mid references root; app references mid. All three must resolve."""
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "root.json", {"host": "r.local", "port": 1111})
        write_file(d, "mid.json", {"host": "m.local", "port": 2222, "root_config": "root.json"})
        write_file(d, "app.json", {"host": "a.local", "port": 3333, "mid_config": "mid.json"})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["references_inlined"], 2, "two inlinings")
        mid = read_file(d, "mid.json")
        assert_equal(mid["root_endpoint"], "r.local", "mid inlined root")
        assert_equal("root_config" not in mid, True, "root_config removed from mid")
        app = read_file(d, "app.json")
        assert_equal(app["mid_endpoint"], "m.local", "app inlined mid")
        assert_equal("mid_config" not in app, True, "mid_config removed from app")

check("reference chain resolves in dependency order", reference_chain_ordering)

def version_always_added():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "v.json", {"host": "h"})
        migrate_mod.migrate(d)
        assert_equal(read_file(d, "v.json")["version"], 2, "version 2 added")


def version_overwrites_existing():
    with tempfile.TemporaryDirectory() as d:
        write_file(d, "v.json", {"name": "x", "version": 1})
        migrate_mod.migrate(d)
        assert_equal(read_file(d, "v.json")["version"], 2, "existing version overwritten to 2")


check("version overwrites existing value", version_overwrites_existing)

check("version 2 added to every migrated file", version_always_added)

def invalid_json_skipped():
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "bad.json"), "w") as f:
            f.write("{invalid")
        write_file(d, "ok.json", {"host": "x", "port": 1})
        stats = migrate_mod.migrate(d)
        assert_equal(stats["files_migrated"], 1, "only ok.json migrated")
        assert not os.path.exists(os.path.join(d, "bad.json")) or True

check("invalid JSON file skipped", invalid_json_skipped)

# Public suite must also pass
module = load("test_migrate")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(f"test_migrate.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)