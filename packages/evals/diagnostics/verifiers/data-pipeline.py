#!/usr/bin/env python3
"""External verifier for data-pipeline. Every check derives only from SPEC text.
No reference implementation is consulted."""
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


parser_mod = load("parser")
validator_mod = load("validator")
transformer_mod = load("transformer")
pipeline_mod = load("pipeline")

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


# --- Parser extended checks ---

def parser_skips_empty_and_comments():
    text = "# header\n\n\n# another\nname=X\n"
    assert_equal(parser_mod.parse(text), [{"name": "X"}], "parse skips empty/comments")


check("parser skips empty and comments", parser_skips_empty_and_comments)


def parser_comment_only_first_char():
    text = "# real comment\n#name=X\nname=Y#hash\n"
    assert_equal(parser_mod.parse(text), [{"name": "Y#hash"}],
                 "only leading # starts comments")


check("parser treats only leading hash as comment", parser_comment_only_first_char)


def parser_duplicate_key_last_wins():
    assert_equal(parser_mod.parse("a=1 a=2 b=3"), [{"a": "2", "b": "3"}], "last wins")


check("parser duplicate key last wins", parser_duplicate_key_last_wins)


def parser_value_with_equals():
    text = "key=val=ue\n"
    assert_equal(parser_mod.parse(text), [{"key": "val=ue"}], "first = only")


check("parser splits on first equals", parser_value_with_equals)


# --- Validator extended checks ---

def validator_empty_age_rejected():
    valid, invalid = validator_mod.validate([{"name": "A", "age": "", "role": "user"}])
    assert_equal(len(valid), 0, "empty age invalid")


check("validator rejects empty age", validator_empty_age_rejected)


def validator_negative_age_rejected():
    valid, invalid = validator_mod.validate([{"name": "A", "age": "-1", "role": "user"}])
    assert_equal(len(valid), 0, "negative age invalid")




def validator_empty_name_rejected():
    valid, invalid = validator_mod.validate([{"name": "", "age": "30", "role": "user"}])
    assert_equal(len(valid), 0, "empty name invalid")
    assert_equal(len(invalid), 1, "empty name counted invalid")


check("validator rejects empty name", validator_empty_name_rejected)


def validator_missing_age_rejected():
    valid, invalid = validator_mod.validate([{"name": "A", "role": "user"}])
    assert_equal(len(valid), 0, "missing age invalid")
    assert_equal(len(invalid), 1, "missing age counted invalid")


check("validator rejects missing age key", validator_missing_age_rejected)
check("validator rejects negative age", validator_negative_age_rejected)


def validator_admin_exactly_18_ok():
    valid, invalid = validator_mod.validate([{"name": "A", "age": "18", "role": "admin"}])
    assert_equal(len(valid), 1, "admin age 18 valid")


check("validator admin age 18 is valid", validator_admin_exactly_18_ok)


def validator_order_rules_1_to_4():
    """Rule 1 checked before rule 4: missing name is caught before admin age check."""
    valid, invalid = validator_mod.validate([{"age": "16", "role": "admin"}])
    assert_equal(len(invalid), 1, "invalid")
    assert_equal(len(valid), 0, "no valid")


check("validator checks rules in order", validator_order_rules_1_to_4)


def validator_multiple_records_mixed():
    recs = [
        {"name": "A", "age": "25", "role": "user"},
        {"name": "B", "age": "999", "role": "guest"},
        {"name": "C", "age": "30", "role": "admin"},
    ]
    valid, invalid = validator_mod.validate(recs)
    assert_equal(len(valid), 2, "two valid")
    assert_equal(len(invalid), 1, "one invalid")


check("validator handles mixed valid/invalid", validator_multiple_records_mixed)


# --- Transformer extended checks ---

def transformer_sort_tiebreak_count_then_role():
    recs = [
        {"name": "A", "age": "20", "role": "guest"},
        {"name": "B", "age": "21", "role": "guest"},
        {"name": "C", "age": "22", "role": "user"},
        {"name": "D", "age": "23", "role": "admin"},
    ]
    out = transformer_mod.transform(recs)
    # guest=2:20:21, admin=1:23:23, user=1:22:22 (count desc, role asc)
    assert_equal(out, ["guest=2:20:21", "admin=1:23:23", "user=1:22:22"], "sort order")


check("transformer sort tiebreak count desc then role asc", transformer_sort_tiebreak_count_then_role)


def transformer_all_filtered_returns_empty():
    recs = [{"name": "A", "age": "10", "role": "user"}]
    assert_equal(transformer_mod.transform(recs), [], "all minors filtered")


check("transformer all-minors input returns empty", transformer_all_filtered_returns_empty)


def transformer_age_18_boundary_kept():
    recs = [
        {"name": "A", "age": "18", "role": "user"},
        {"name": "B", "age": "17", "role": "user"},
    ]
    assert_equal(transformer_mod.transform(recs), ["user=1:18:18"], "age 18 kept, 17 filtered")


check("transformer keeps exactly 18 and filters 17", transformer_age_18_boundary_kept)


# --- Pipeline extended checks ---

def pipeline_stats_accuracy():
    text = "name=A age=25 role=admin\nname=B age=17 role=user\nname=C age=30 role=badrole\n"
    out, stats = pipeline_mod.run(text)
    # A valid (admin, age 25), B valid (user, age 17 — cross-field only applies to admin), C invalid (bad role)
    assert_equal(stats["parsed"], 3, "parsed")
    assert_equal(stats["valid"], 2, "valid (A and B)")
    assert_equal(stats["invalid"], 1, "invalid (C bad role)")
    assert_equal(stats["output_groups"], 1, "1 group (A only after transformer filters age<18)")


check("pipeline stats accuracy", pipeline_stats_accuracy)


def pipeline_all_comment_lines():
    text = "# just\n# comments\n"
    out, stats = pipeline_mod.run(text)
    assert_equal(out, [], "empty output")
    assert_equal(stats, {"parsed": 0, "valid": 0, "invalid": 0, "output_groups": 0}, "zero stats")


check("pipeline all comments yields zero stats", pipeline_all_comment_lines)


def pipeline_preserves_module_contracts():
    """Verify pipeline returns (list[str], dict) not nested structures."""
    out, stats = pipeline_mod.run("name=X age=20 role=user\n")
    assert_equal(isinstance(out, list), True, "output is list")
    assert_equal(isinstance(out[0], str) if out else True, True, "output elements are strings")
    assert_equal(isinstance(stats, dict), True, "stats is dict")
    for k in ("parsed", "valid", "invalid", "output_groups"):
        assert_equal(k in stats, True, f"stats has {k}")


check("pipeline return types match contract", pipeline_preserves_module_contracts)


# --- Public suite must also pass ---

module = load("test_pipeline")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(f"test_pipeline.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)