import unittest

from cache import Cache


class CacheTest(unittest.TestCase):
    def test_loads_each_key_once(self):
        cache = Cache()
        calls = 0

        def load():
            nonlocal calls
            calls += 1
            return 7

        self.assertEqual(cache.get("answer", load), 7)
        self.assertEqual(cache.get("answer", load), 7)
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
