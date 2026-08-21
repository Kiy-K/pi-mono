import unittest

import parser as p
import validator as v
import transformer as t
import pipeline as pl


class ParserTest(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(p.parse(""), [])

    def test_comments_and_blanks_skipped(self):
        text = "# header\n\nname=Alice\n# another\n"
        self.assertEqual(p.parse(text), [{"name": "Alice"}])

    def test_single_record(self):
        self.assertEqual(p.parse("name=Bob age=20"), [{"name": "Bob", "age": "20"}])

    def test_malformed_line_skipped(self):
        text = "name=Ok\nbadline\nname=Also"
        self.assertEqual(p.parse(text), [{"name": "Ok"}, {"name": "Also"}])

    def test_duplicate_key_last_wins(self):
        self.assertEqual(p.parse("name=A name=B"), [{"name": "B"}])


class ValidatorTest(unittest.TestCase):
    def test_all_valid(self):
        recs = [{"name": "A", "age": "25", "role": "user"}]
        valid, invalid = v.validate(recs)
        self.assertEqual(len(valid), 1)
        self.assertEqual(len(invalid), 0)

    def test_missing_name(self):
        valid, invalid = v.validate([{"age": "30", "role": "admin"}])
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 1)

    def test_bad_age_type(self):
        valid, invalid = v.validate([{"name": "A", "age": "old", "role": "user"}])
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 1)

    def test_age_out_of_range(self):
        valid, invalid = v.validate([{"name": "A", "age": "200", "role": "user"}])
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 1)

    def test_bad_role(self):
        valid, invalid = v.validate([{"name": "A", "age": "30", "role": "superadmin"}])
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 1)

    def test_admin_under_18(self):
        valid, invalid = v.validate([{"name": "A", "age": "16", "role": "admin"}])
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 1)

    def test_user_under_18_valid(self):
        valid, invalid = v.validate([{"name": "A", "age": "16", "role": "user"}])
        self.assertEqual(len(valid), 1)


class TransformerTest(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(t.transform([]), [])

    def test_filters_minors(self):
        recs = [{"name": "A", "age": "15", "role": "user"}, {"name": "B", "age": "25", "role": "user"}]
        out = t.transform(recs)
        self.assertEqual(out, ["user=1:25:25"])

    def test_groups_and_sorts(self):
        recs = [
            {"name": "A", "age": "30", "role": "admin"},
            {"name": "B", "age": "25", "role": "user"},
            {"name": "C", "age": "35", "role": "admin"},
        ]
        out = t.transform(recs)
        self.assertEqual(out, ["admin=2:30:35", "user=1:25:25"])


class PipelineTest(unittest.TestCase):
    def test_worked_example(self):
        text = (
            "name=John age=30 role=admin\n"
            "name=Jane age=25 role=user\n"
            "name=Bob age=35 role=admin\n"
            "age=17 role=user\n"
            "name=Eve age=28 role=admin\n"
            "name=Charlie age=45 role=guest\n"
            "name=Dave age=12 role=user\n"
        )
        out, stats = pl.run(text)
        self.assertEqual(out, ["admin=3:28:35", "guest=1:45:45", "user=1:25:25"])
        self.assertEqual(stats, {"parsed": 7, "valid": 6, "invalid": 1, "output_groups": 3})

    def test_empty_input(self):
        out, stats = pl.run("")
        self.assertEqual(out, [])
        self.assertEqual(stats, {"parsed": 0, "valid": 0, "invalid": 0, "output_groups": 0})

    def test_all_invalid(self):
        text = "age=30\nage=40\n"
        out, stats = pl.run(text)
        self.assertEqual(out, [])
        self.assertEqual(stats["parsed"], 2)
        self.assertEqual(stats["invalid"], 2)


if __name__ == "__main__":
    unittest.main()