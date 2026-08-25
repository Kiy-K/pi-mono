#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "ranges.py"
spec = importlib.util.spec_from_file_location("ranges", path)
module = importlib.util.module_from_spec(spec)
sys.modules["ranges"] = module  # dataclasses resolves cls.__module__ via sys.modules; `from __future__ import annotations` submissions crash without this
spec.loader.exec_module(module)
cases = [((2, 5), [2, 3, 4, 5]), ((0, 0), [0]), ((-2, 1), [-2, -1, 0, 1])]
passed = all(module.inclusive_range(*args) == expected for args, expected in cases)
print(json.dumps({"passed": passed, "tests": len(cases)}))
sys.exit(0 if passed else 1)
