#!/usr/bin/env python3
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "ranges.py"
from _common import load_module

module = load_module(path.parent, "ranges")
cases = [((2, 5), [2, 3, 4, 5]), ((0, 0), [0]), ((-2, 1), [-2, -1, 0, 1])]
passed = all(module.inclusive_range(*args) == expected for args, expected in cases)
print(json.dumps({"passed": passed, "tests": len(cases)}))
sys.exit(0 if passed else 1)
