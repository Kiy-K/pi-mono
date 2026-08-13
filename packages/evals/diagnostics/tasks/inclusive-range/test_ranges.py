import unittest

from ranges import inclusive_range


class InclusiveRangeTest(unittest.TestCase):
    def test_includes_both_positive_endpoints(self):
        self.assertEqual(inclusive_range(2, 5), [2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
