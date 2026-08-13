import unittest

from config import resolve_config


class ResolveConfigTest(unittest.TestCase):
    def test_cli_overrides_other_sources(self):
        self.assertEqual(
            resolve_config(
                {"port": 3000},
                {"port": 4000},
                {"port": 5000},
                {"port": 6000},
            )["port"],
            6000,
        )


if __name__ == "__main__":
    unittest.main()
