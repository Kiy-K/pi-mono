import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store
from replica import Replica
from controller import Controller


class CacheConsistencyTest(unittest.TestCase):
    def test_miss_then_hit(self):
        store = Store()
        replica = Replica(store)
        self.assertIsNone(replica.read("a"))
        store.put("a", "1")
        self.assertEqual(replica.read("a"), ("1", 1))  # miss
        self.assertEqual(replica.read("a"), ("1", 1))  # hit
        store.put("a", "2")
        self.assertEqual(replica.read("a"), ("2", 2))  # stale hit refills

    def test_invalidate_returns_presence(self):
        store = Store()
        replica = Replica(store)
        self.assertFalse(replica.invalidate("ghost"))
        store.put("k", "v")
        replica.read("k")
        self.assertTrue(replica.invalidate("k"))
        self.assertFalse(replica.invalidate("k"))

    def test_sync_stats_and_audit_cycle(self):
        store = Store()
        replica = Replica(store)
        controller = Controller(store, replica)
        self.assertEqual(controller.sync({}), {"puts": 0})
        self.assertEqual(controller.audit(), {"stale": [], "fresh": 0})
        controller.sync({"b": "2", "a": "1"})
        # Replica untouched by sync: both keys uncached -> stale, pre-repair.
        self.assertEqual(controller.audit(), {"stale": ["a", "b"], "fresh": 0})
        # Audit repaired; second audit clean.
        self.assertEqual(controller.audit(), {"stale": [], "fresh": 2})
        store.put("a", "1")  # same value, new version 2
        self.assertEqual(controller.audit(), {"stale": ["a"], "fresh": 1})
        self.assertEqual(controller.audit(), {"stale": [], "fresh": 2})

    def test_worked_example(self):
        store = Store()
        replica = Replica(store)
        controller = Controller(store, replica)

        store.put("b", "beta")  # seed the store; cache empty
        self.assertEqual(replica.read("b"), ("beta", 1))
        self.assertEqual(controller.sync({"a": "x", "b": "y"}), {"puts": 2})
        self.assertEqual(replica.pending(), ["b"])
        self.assertEqual(replica.read("a"), ("x", 1))
        self.assertEqual(replica.pending(), ["b"])
        self.assertEqual(replica.read("b"), ("y", 2))
        self.assertEqual(replica.pending(), [])
        self.assertEqual(controller.audit(), {"stale": [], "fresh": 2})
        controller.sync({"a": "z"})
        self.assertEqual(controller.audit(), {"stale": ["a"], "fresh": 1})
        self.assertEqual(replica.read("a"), ("z", 2))
        self.assertEqual(controller.audit(), {"stale": [], "fresh": 2})


if __name__ == "__main__":
    unittest.main()
