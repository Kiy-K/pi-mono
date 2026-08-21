import json
import os
import tempfile
import unittest

from store import EventStore


class ApplyTest(unittest.TestCase):
    def test_set_and_get(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            stats = store.apply([{"type": "set", "key": "a", "value": "1"}])
            self.assertEqual(store.get("a"), "1")
            self.assertEqual(stats, {"processed": 1, "set": 1, "deleted": 0})

    def test_update_existing(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            store.apply([{"type": "set", "key": "a", "value": "1"}])
            stats = store.apply([{"type": "set", "key": "a", "value": "2"}])
            self.assertEqual(store.get("a"), "2")
            self.assertEqual(stats["set"], 1)

    def test_delete(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            store.apply([{"type": "set", "key": "a", "value": "1"}])
            stats = store.apply([{"type": "delete", "key": "a"}])
            self.assertIsNone(store.get("a"))
            self.assertEqual(stats["deleted"], 1)

    def test_delete_nonexistent_noop(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            stats = store.apply([{"type": "delete", "key": "ghost"}])
            self.assertEqual(stats["deleted"], 1)

    def test_skip_unknown_type(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            stats = store.apply([{"type": "bogus", "key": "a"}])
            self.assertEqual(stats["processed"], 0)


class KeysTest(unittest.TestCase):
    def test_sorted_keys(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            store.apply([
                {"type": "set", "key": "c", "value": "3"},
                {"type": "set", "key": "a", "value": "1"},
                {"type": "set", "key": "b", "value": "2"},
            ])
            self.assertEqual(store.keys(), ["a", "b", "c"])


class VerifyTest(unittest.TestCase):
    def test_verify_consistent(self):
        with tempfile.TemporaryDirectory() as d:
            store = EventStore(os.path.join(d, "db.jsonl"))
            store.apply([{"type": "set", "key": "x", "value": "10"}])
            self.assertTrue(store.verify())

    def test_verify_detects_tamper(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "db.jsonl")
            store = EventStore(path)
            store.apply([{"type": "set", "key": "x", "value": "10"}])
            # Tamper with the file
            with open(path, "w") as f:
                f.write('{"key":"x","value":"TAMPERED"}\n')
            self.assertFalse(store.verify())


class PersistenceTest(unittest.TestCase):
    def test_reload_from_disk(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "db.jsonl")
            store1 = EventStore(path)
            store1.apply([{"type": "set", "key": "k", "value": "v"}])
            # Reload in a new instance
            store2 = EventStore(path)
            self.assertEqual(store2.get("k"), "v")


if __name__ == "__main__":
    unittest.main()