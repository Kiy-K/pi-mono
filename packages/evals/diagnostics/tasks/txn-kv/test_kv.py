import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kv import TxnKV


class BasicTest(unittest.TestCase):
    def test_set_get_direct_mode(self):
        kv = TxnKV()
        self.assertIsNone(kv.get("a"))
        kv.set("a", "1")
        self.assertEqual(kv.get("a"), "1")
        kv.set("a", "2")
        self.assertEqual(kv.get("a"), "2")

    def test_delete_returns_visibility(self):
        kv = TxnKV()
        self.assertFalse(kv.delete("ghost"))
        kv.set("a", "1")
        self.assertTrue(kv.delete("a"))
        self.assertIsNone(kv.get("a"))
        self.assertFalse(kv.delete("a"))

    def test_txn_ids_monotonic(self):
        kv = TxnKV()
        ids = [kv.begin() for _ in range(4)]
        self.assertEqual(ids, [1, 2, 3, 4])
        kv.commit(ids[3])
        kv.rollback(ids[2])
        self.assertEqual(kv.begin(), 5)


class IsolationTest(unittest.TestCase):
    def test_read_your_writes_staged_not_committed(self):
        kv = TxnKV()
        t1 = kv.begin()
        kv.set("a", "v1")
        # Staged write visible inside the transaction...
        self.assertEqual(kv.get("a"), "v1")
        # ...but a second transaction's snapshot does not see it.
        t2 = kv.begin()
        self.assertIsNone(kv.get("a"))  # innermost is now t2
        kv.rollback(t2)
        kv.commit(t1)

    def test_snapshot_ignores_later_foreign_commit(self):
        kv = TxnKV()
        t1 = kv.begin()
        t2 = kv.begin()
        kv.set("k", "from-t2")   # innermost: t2
        kv.commit(t2)            # commits k="from-t2"
        self.assertIsNone(kv.get("k"))  # innermost: t1, snapshot predates commit
        kv.set("k", "from-t1")
        self.assertEqual(kv.get("k"), "from-t1")  # own staged write wins
        kv.commit(t1)

    def test_outer_sees_own_snapshot_after_inner_commit(self):
        kv = TxnKV()
        kv.set("a", "base")
        t1 = kv.begin()          # snapshot {"a": "base"}
        t2 = kv.begin()
        kv.set("a", "inner")
        kv.commit(t2)
        self.assertEqual(kv.get("a"), "base")  # t1 snapshot, not committed state
        kv.rollback(t1)

    def test_never_observes_other_open_transaction_stage(self):
        kv = TxnKV()
        t1 = kv.begin()
        kv.set("s", "t1-value")  # staged in t1
        t2 = kv.begin()          # innermost is now t2
        self.assertIsNone(kv.get("s"))  # t2 cannot see t1's uncommitted set
        kv.set("s", "t2-value")  # t2's own stage
        self.assertEqual(kv.get("s"), "t2-value")  # read-your-writes for t2
        kv.rollback(t2)
        self.assertEqual(kv.get("s"), "t1-value")  # routing returns to t1
        kv.commit(t1)
        self.assertEqual(kv.get("s"), "t1-value")

    def test_routing_back_to_outer_after_finish(self):
        kv = TxnKV()
        kv.set("outer", "o1")
        t1 = kv.begin()          # snapshot outer=o1
        t2 = kv.begin()
        kv.set("x", "t2")
        kv.commit(t2)
        self.assertIsNone(kv.get("x"))     # t1 snapshot
        self.assertEqual(kv.get("outer"), "o1")
        kv.set("y", "t1")                  # routes to t1 again
        kv.commit(t1)
        self.assertEqual(kv.get("y"), "t1")


class CommitTest(unittest.TestCase):
    def test_commit_stats_and_merge_order(self):
        kv = TxnKV()
        t = kv.begin()
        kv.set("a", "1")
        kv.delete("a")           # set then delete: key absent after merge
        kv.set("b", "2")
        stats = kv.commit(t)
        self.assertEqual(stats, {"committed": 3})
        self.assertIsNone(kv.get("a"))
        self.assertEqual(kv.get("b"), "2")

    def test_tombstone_of_invisible_key_commits_as_noop_but_counts(self):
        kv = TxnKV()
        t = kv.begin()
        self.assertFalse(kv.delete("never-existed"))
        self.assertEqual(kv.commit(t), {"committed": 1})
        self.assertIsNone(kv.get("never-existed"))

    def test_double_commit_raises_keyerror(self):
        kv = TxnKV()
        t = kv.begin()
        kv.commit(t)
        with self.assertRaises(KeyError):
            kv.commit(t)

    def test_unknown_txn_commit_raises_keyerror(self):
        kv = TxnKV()
        with self.assertRaises(KeyError):
            kv.commit(99)

    def test_double_rollback_raises_keyerror(self):
        kv = TxnKV()
        t = kv.begin()
        kv.rollback(t)
        with self.assertRaises(KeyError):
            kv.rollback(t)

    def test_finished_txn_invalid_for_all_ops(self):
        kv = TxnKV()
        t = kv.begin()
        kv.commit(t)
        for call in (
            lambda: kv.commit(t),
            lambda: kv.rollback(t),
            lambda: kv.savepoint(t),
            lambda: kv.rollback_to(t, "sp1"),
        ):
            with self.assertRaises(KeyError):
                call()


class SavepointTest(unittest.TestCase):
    def test_savepoint_names_and_counters_independent(self):
        kv = TxnKV()
        t1 = kv.begin()
        t2 = kv.begin()
        self.assertEqual(kv.savepoint(t1), "sp1")
        self.assertEqual(kv.savepoint(t2), "sp1")
        self.assertEqual(kv.savepoint(t1), "sp2")

    def test_rollback_to_counts_and_discard(self):
        kv = TxnKV()
        t = kv.begin()
        kv.set("x", "1")
        sp1 = kv.savepoint(t)
        kv.set("y", "2")
        sp2 = kv.savepoint(t)
        kv.set("z", "3")
        self.assertEqual(kv.rollback_to(t, sp2), {"undone": 1})
        self.assertEqual(kv.rollback_to(t, sp2), {"undone": 0})  # sp2 still valid
        self.assertEqual(kv.rollback_to(t, sp1), {"undone": 1})
        with self.assertRaises(KeyError):
            kv.rollback_to(t, sp2)          # discarded by the rollback_to sp1 above
        self.assertEqual(kv.rollback_to(t, sp1), {"undone": 0})  # sp1 stays valid
        self.assertIsNone(kv.get("y"))
        self.assertEqual(kv.get("x"), "1")

    def test_savepoint_counter_survives_rollbacks(self):
        kv = TxnKV()
        t = kv.begin()
        self.assertEqual(kv.savepoint(t), "sp1")
        kv.rollback_to(t, "sp1")
        self.assertEqual(kv.savepoint(t), "sp2")  # never reuse names

    def test_unknown_savepoint_name_raises_keyerror(self):
        kv = TxnKV()
        t = kv.begin()
        with self.assertRaises(KeyError):
            kv.rollback_to(t, "nope")
        kv.rollback(t)

    def test_savepoints_are_per_transaction(self):
        kv = TxnKV()
        t1 = kv.begin()
        t2 = kv.begin()
        kv.savepoint(t1)
        with self.assertRaises(KeyError):
            kv.rollback_to(t2, "sp1")       # belongs to t1
        kv.rollback(t2)
        kv.rollback(t1)

    def test_rollback_to_zero_ops_ok(self):
        kv = TxnKV()
        t = kv.begin()
        sp = kv.savepoint(t)
        self.assertEqual(kv.rollback_to(t, sp), {"undone": 0})

    def test_full_rollback_discards_savepoints(self):
        kv = TxnKV()
        t = kv.begin()
        kv.savepoint(t)
        kv.rollback(t)
        with self.assertRaises(KeyError):
            kv.rollback_to(t, "sp1")


class MixedTest(unittest.TestCase):
    def test_worked_example_1(self):
        kv = TxnKV()
        t1 = kv.begin()
        self.assertIsNone(kv.get("a"))
        kv.set("a", "v1")
        self.assertEqual(kv.get("a"), "v1")
        t2 = kv.begin()
        kv.set("a", "v2")
        self.assertEqual(kv.commit(t2), {"committed": 1})
        self.assertEqual(kv.get("a"), "v1")
        self.assertTrue(kv.delete("a"))
        self.assertEqual(kv.commit(t1), {"committed": 2})
        self.assertIsNone(kv.get("a"))

    def test_worked_example_3(self):
        kv = TxnKV()
        kv.set("live", "1")
        t = kv.begin()
        self.assertTrue(kv.delete("live"))
        self.assertFalse(kv.delete("ghost"))
        t2 = kv.begin()
        kv.set("other", "2")
        self.assertEqual(kv.commit(t), {"committed": 2})
        self.assertEqual(kv.commit(t2), {"committed": 1})
        self.assertIsNone(kv.get("live"))
        self.assertIsNone(kv.get("ghost"))
        self.assertEqual(kv.get("other"), "2")

    def test_out_of_order_finish_then_new_txn_sees_merged_state(self):
        kv = TxnKV()
        t1 = kv.begin()
        t2 = kv.begin()
        kv.set("m", "t1")       # t1
        kv.commit(t1)
        kv.set("m", "t2")       # now routes to t2
        kv.commit(t2)           # last-write-wins
        self.assertEqual(kv.get("m"), "t2")
        t3 = kv.begin()
        self.assertEqual(kv.get("m"), "t2")  # fresh snapshot sees merged state


if __name__ == "__main__":
    unittest.main()
