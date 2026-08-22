import unittest

from errors import CycleError, StageFailureError
from runner import Pipeline
import stages
from stages import STAGES, stage, run_stage


def setUpModule():
    # Deterministic registry for the whole suite.
    STAGES.clear()

    @stage("a")
    def a(payload):
        return {"a": 1}

    @stage("b")
    def b(payload):
        if payload.get("fail_b"):
            raise StageFailureError("b")
        return {"b": 2, "saw": dict(payload)}

    @stage("c")
    def c(payload):
        return {"c": 3, "saw": dict(payload)}

    @stage("d")
    def d(payload):
        return {"d": 4, "saw": dict(payload)}

    @stage("p")
    def p(payload):
        return {"shared": "from-p", "p_out": 1}

    @stage("q")
    def q(payload):
        return {"q_out": 2}

    @stage("r")
    def r(payload):
        return {"saw": dict(payload)}

    @stage("boom")
    def boom(payload):
        raise ValueError("not a StageFailureError")


def _reg_q_saw():
    def qsaw(payload):
        return {"saw": dict(payload)}

    stages.stage("qsaw")(qsaw)


class DiamondTest(unittest.TestCase):
    def test_order_and_merge(self):
        pipeline = Pipeline([("a", "c"), ("b", "c"), ("a", "d")])
        result = pipeline.execute({"env": "prod"})
        self.assertEqual(list(result["results"].keys()), ["a", "b", "c", "d"])
        self.assertEqual(result["failed"], [])
        self.assertEqual(result["skipped"], [])
        saw = result["results"]["c"]["saw"]
        for key, value in {"env": "prod", "a": 1, "b": 2}.items():
            self.assertEqual(saw.get(key), value)

    def test_duplicate_edge_ignored(self):
        pipeline = Pipeline([("a", "c"), ("a", "c")])
        result = pipeline.execute({})
        self.assertEqual(list(result["results"].keys()), ["a", "c"])

    def test_empty_edges(self):
        pipeline = Pipeline([])
        self.assertEqual(pipeline.execute({"x": 1}), {"results": {}, "failed": [], "skipped": []})


class PayloadFlowTest(unittest.TestCase):
    def test_merge_precedence(self):
        pipeline = Pipeline([("p", "r"), ("q", "r")])
        result = pipeline.execute({"env": "prod", "shared": "entry"}, stop_on_error=True)
        self.assertEqual(
            result["results"]["r"]["saw"],
            {"env": "prod", "shared": "from-p", "p_out": 1, "q_out": 2},
        )

    def test_stage_receives_merged_payload(self):
        _reg_q_saw()

        def cleanup():
            del STAGES["qsaw"]

        self.addCleanup(cleanup)
        pipeline = Pipeline([("p", "qsaw")])
        result = pipeline.execute({"seed": 9})
        self.assertEqual(result["results"]["qsaw"], {"saw": {"seed": 9, "shared": "from-p", "p_out": 1}})


class CycleTest(unittest.TestCase):
    def test_three_node_cycle_raises(self):
        pipeline = Pipeline([("x", "y"), ("y", "z"), ("z", "x")])
        with self.assertRaises(CycleError) as caught:
            pipeline.execute({})
        message = str(caught.exception)
        self.assertTrue(any(name in message for name in ("x", "y", "z")))

    def test_nothing_runs_on_cycle(self):
        ran = []
        STAGES["x"] = lambda payload: ran.append("x") or {}
        try:
            pipeline = Pipeline([("x", "y"), ("y", "x")])
            with self.assertRaises(CycleError):
                pipeline.execute({})
            self.assertEqual(ran, [])
        finally:
            del STAGES["x"]

    def test_self_edge_is_cycle(self):
        pipeline = Pipeline([("solo", "solo")])
        with self.assertRaises(CycleError):
            pipeline.execute({})


class FailureTest(unittest.TestCase):
    def test_stop_on_error_true_stops_immediately(self):
        pipeline = Pipeline([("a", "b"), ("b", "c"), ("a", "d")])
        result = pipeline.execute({"fail_b": True}, stop_on_error=True)
        self.assertEqual(list(result["results"].keys()), ["a"])
        self.assertEqual(result["failed"], ["b"])
        self.assertEqual(result["skipped"], [])

    def test_stop_on_error_false_skips_descendants(self):
        pipeline = Pipeline([("a", "b"), ("b", "c"), ("a", "d")])
        result = pipeline.execute({"fail_b": True}, stop_on_error=False)
        self.assertEqual(sorted(result["results"].keys()), ["a", "d"])
        self.assertEqual(result["failed"], ["b"])
        self.assertEqual(result["skipped"], ["c"])
        self.assertEqual(result["results"]["d"]["saw"], {"fail_b": True, "a": 1})

    def test_other_exceptions_propagate(self):
        pipeline = Pipeline([("a", "boom")])
        with self.assertRaises(ValueError):
            pipeline.execute({})


class RegistryTest(unittest.TestCase):
    def test_unknown_stage_at_execute_keyerror(self):
        pipeline = Pipeline([("a", "ghost")])
        with self.assertRaises(KeyError):
            pipeline.execute({})

    def test_run_stage_unknown_name(self):
        with self.assertRaises(KeyError):
            run_stage("nope-not-here", {})

    def test_reregistration_last_wins(self):
        def first(payload):
            return {"v": 1}

        def second(payload):
            return {"v": 2}

        stages.stage("temp")(first)
        stages.stage("temp")(second)
        try:
            self.assertEqual(run_stage("temp", {}), {"v": 2})
        finally:
            del STAGES["temp"]


if __name__ == "__main__":
    unittest.main()
