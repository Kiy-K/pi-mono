import json
import os
import tempfile
import unittest

from migrate import migrate


def write_file(directory, name, content):
    path = os.path.join(directory, name)
    with open(path, "w") as f:
        json.dump(content, f)
    return path


def read_file(directory, name):
    with open(os.path.join(directory, name)) as f:
        return json.load(f)


class MigrateTest(unittest.TestCase):
    def test_worked_example(self):
        with tempfile.TemporaryDirectory() as d:
            write_file(d, "db.json", {"host": "localhost", "port": 5432, "name": "mydb"})
            write_file(d, "cache.json", {"host": "redis.local", "port": 6379})
            write_file(d, "app.json", {
                "host": "0.0.0.0", "port": 8080,
                "db_config": "db.json", "cache_config": "cache.json"
            })
            stats = migrate(d)
            self.assertEqual(stats["files_migrated"], 3)
            self.assertEqual(stats["fields_renamed"], 3)
            self.assertEqual(stats["ports_coerced"], 3)
            self.assertEqual(stats["references_inlined"], 2)
            # Verify migrated file contents
            db = read_file(d, "db.json")
            self.assertEqual(db["endpoint"], "localhost")
            self.assertEqual(db["port"], "5432")
            self.assertEqual(db["version"], 2)
            app = read_file(d, "app.json")
            self.assertEqual(app["db_endpoint"], "localhost")
            self.assertEqual(app["cache_endpoint"], "redis.local")
            self.assertNotIn("db_config", app)
            self.assertNotIn("cache_config", app)

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as d:
            stats = migrate(d)
            self.assertEqual(stats, {
                "files_migrated": 0, "fields_renamed": 0,
                "ports_coerced": 0, "references_inlined": 0
            })

    def test_no_rename_no_coerce(self):
        with tempfile.TemporaryDirectory() as d:
            write_file(d, "simple.json", {"name": "test", "enabled": False})
            stats = migrate(d)
            self.assertEqual(stats["files_migrated"], 1)
            self.assertEqual(stats["fields_renamed"], 0)
            self.assertEqual(stats["ports_coerced"], 0)
            f = read_file(d, "simple.json")
            self.assertEqual(f["version"], 2)
            self.assertEqual(f["enabled"], False)

    def test_invalid_json_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "bad.json"), "w") as f:
                f.write("{invalid json")
            write_file(d, "good.json", {"host": "x", "port": 1})
            stats = migrate(d)
            self.assertEqual(stats["files_migrated"], 1)


if __name__ == "__main__":
    unittest.main()