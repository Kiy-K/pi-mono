#!/usr/bin/env python3
"""External verifier for pipeline-runner. Every check derives only from SPEC text."""
import pathlib
import sys
import types
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))

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


def load(name):
    return load_module(root, name)


errors_mod = load("errors")
stages_mod = load("stages")
runner_mod = load("runner")

CycleError = errors_mod.CycleError
StageFailureError = errors_mod.StageFailureError
STAGES = stages_mod.STAGES

# --- Reference stage set -------------------------------------------------
C_SAW = []


def _reg(name, fn):
    try:
        stages_mod.stage(name)(fn)
    except (NotImplementedError, Exception):
        STAGES[name] = fn


_reg("a", lambda payload: {"a": 1})
def _b(payload):
    if payload.get("fail_b"):
        raise StageFailureError("b")
    return {"b": 2}


_reg("b", _b)
def _c(payload):
    C_SAW.append(dict(payload))
    return {"c": 3}


_reg("c", _c)
_reg("d", lambda payload: {"d": 4, "saw": dict(payload)})

# --- Checks --------------------------------------------------------------

def diamond_order_and_merge():
    pipeline = runner_mod.Pipeline([("a", "c"), ("b", "c"), ("a", "d")])
    result = pipeline.execute({"env": "prod"})
    assert_equal(list(result["results"].keys()), ["a", "b", "c", "d"], "diamond order proves lexicographic tie-break")
    assert_equal(result["failed"], [], "no failures in happy path")
    assert_equal(result["skipped"], [], "no skips in happy path")
    assert_equal(C_SAW[-1], {"env": "prod", "a": 1, "b": 2}, "c receives merged upstream outputs")


def duplicate_edge_dedup():
    result = runner_mod.Pipeline([("a", "c"), ("a", "c")]).execute({})
    assert_equal(list(result["results"].keys()), ["a", "c"], "duplicate edge must not double-run a")


def empty_edges():
    result = runner_mod.Pipeline([]).execute({"x": 1})
    assert_equal(result, {"results": {}, "failed": [], "skipped": []}, "empty graph returns empty dict")


def cycle_raises_with_member():
    try:
        runner_mod.Pipeline([("x", "y"), ("y", "z"), ("z", "x")]).execute({})
        raise AssertionError("CycleError not raised")
    except CycleError as error:
        message = str(error)
        if not any(name in message for name in ("x", "y", "z")):
            raise AssertionError(f"message lacks cycle member: {message!r}")


def self_edge_is_cycle():
    try:
        runner_mod.Pipeline([("solo", "solo")]).execute({})
        raise AssertionError("CycleError not raised for self-edge")
    except CycleError:
        pass


def nothing_runs_on_cycle():
    ran = []
    STAGES["x"] = lambda payload: ran.append("x") or {}
    try:
        try:
            runner_mod.Pipeline([("x", "y"), ("y", "x")]).execute({})
            raise AssertionError("CycleError not raised")
        except CycleError:
            pass
        assert_equal(ran, [], "no stage may run when a cycle exists")
    finally:
        del STAGES["x"]


def failure_stop_on_error_true():
    pipeline = runner_mod.Pipeline([("a", "b"), ("b", "c"), ("a", "d")])
    result = pipeline.execute({"fail_b": True}, stop_on_error=True)
    assert_equal(list(result["results"].keys()), ["a"], "stop_on_error halts immediately after failure")
    assert_equal(result["failed"], ["b"], "failed records the failing stage")
    assert_equal(result["skipped"], [], "stopped run records no skips")


def failure_stop_on_error_false():
    pipeline = runner_mod.Pipeline([("a", "b"), ("b", "c"), ("a", "d")])
    result = pipeline.execute({"fail_b": True}, stop_on_error=False)
    assert_equal(sorted(result["results"].keys()), ["a", "d"], "independent node still runs")
    assert_equal(result["failed"], ["b"], "failed records b")
    assert_equal(result["skipped"], ["c"], "descendant of failure is skipped")
    assert_equal(result["results"]["d"]["saw"], {"fail_b": True, "a": 1}, "d receives entry payload plus a output")



def other_exceptions_propagate():
    def boom(payload):
        raise ValueError("plain")

    STAGES["boom"] = boom
    try:
        try:
            runner_mod.Pipeline([("a", "boom")]).execute({})
        except StageFailureError:
            raise AssertionError("runner must not wrap non-StageFailureError exceptions")
        except ValueError:
            pass  # correct: the stage's own exception propagates unchanged
        else:
            raise AssertionError("runner swallowed a non-StageFailureError")
    finally:
        del STAGES["boom"]


def unknown_stage_keyerror_at_execute():
    pipeline = runner_mod.Pipeline([("a", "ghost")])
    try:
        pipeline.execute({})
        raise AssertionError("KeyError not raised for unregistered stage")
    except KeyError:
        pass


def payload_merge_precedence():
    _reg("p", lambda payload: {"shared": "from-p", "p_out": 1})
    _reg("q", lambda payload: {"q_out": 2})
    _reg("r", lambda payload: {"saw": dict(payload)})
    pipeline = runner_mod.Pipeline([("p", "r"), ("q", "r")])
    result = pipeline.execute({"env": "prod", "shared": "entry"})
    assert_equal(
        result["results"]["r"]["saw"],
        {"env": "prod", "shared": "from-p", "p_out": 1, "q_out": 2},
        "later stages overwrite earlier and both overwrite entry payload",
    )


def stage_failure_error_carries_stage():
    error = StageFailureError("xyz")
    assert_equal(error.stage, "xyz", ".stage attribute carries the name")


for fn in [
    diamond_order_and_merge,
    duplicate_edge_dedup,
    empty_edges,
    cycle_raises_with_member,
    self_edge_is_cycle,
    nothing_runs_on_cycle,
    failure_stop_on_error_true,
    failure_stop_on_error_false,
    other_exceptions_propagate,
    unknown_stage_keyerror_at_execute,
    payload_merge_precedence,
    stage_failure_error_carries_stage,
]:
    check(fn.__name__, fn)

# Re-run the task's own public suite as additional evidence.
import io
from _common import load_module

suite = unittest.defaultTestLoader.discover(str(root), pattern="test_runner.py")
public_runner = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0)
public_result = public_runner.run(suite)
total += public_result.testsRun
if not public_result.wasSuccessful():
    for _, trace in getattr(public_result, "failures", []) + getattr(public_result, "errors", []):
        failures.append(f"test_runner.py: {trace.strip().splitlines()[-1]}")

print(__import__("json").dumps({"passed": len(failures) == 0, "tests": total, "failures": failures}))
sys.exit(0 if len(failures) == 0 else 1)
