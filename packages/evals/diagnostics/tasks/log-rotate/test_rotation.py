import tempfile
import unittest
from pathlib import Path

from journal import Journal
from rotation import append_with_rotation, rotate, should_rotate


class ShouldRotateTest(unittest.TestCase):
    def test_size_below_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "journal.jsonl"
            path.write_text("x" * 10, encoding="utf-8")
            self.assertFalse(should_rotate(str(path), 100))

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "journal.jsonl"
            self.assertFalse(should_rotate(str(path), 1))


class RotateTest(unittest.TestCase):
    def test_creates_first_slot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "journal.jsonl"
            path.write_text("entries", encoding="utf-8")
            rotated = rotate(str(path), 3)
            self.assertEqual(rotated, ["journal.jsonl.1"])
            self.assertFalse(path.exists())

    def test_missing_active_file_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "journal.jsonl"
            self.assertEqual(rotate(str(path), 3), [])


class AppendWithRotationTest(unittest.TestCase):
    def test_appends_without_rotation_under_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = Journal(str(Path(tmp) / "journal.jsonl"))
            self.assertEqual(append_with_rotation(journal, {"n": 1}, 100, 3), [])
            self.assertEqual(journal.read_all(), [{"n": 1}])

    def test_rotates_when_full(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = Journal(str(Path(tmp) / "journal.jsonl"))
            append_with_rotation(journal, {"n": 1}, 1, 3)
            rotated = append_with_rotation(journal, {"n": 2}, 1, 3)
            self.assertEqual(rotated, ["journal.jsonl.1"])
            self.assertEqual(journal.read_all(), [{"n": 2}])


if __name__ == "__main__":
    unittest.main()
