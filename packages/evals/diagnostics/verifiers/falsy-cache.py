#!/usr/bin/env python3
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "cache.py"
from _common import load_module

module = load_module(path.parent, "cache")
passed = True
for value in (0, False, "", None):
    calls = []
    cache = module.Cache()
    first = cache.get("key", lambda: calls.append(1) or value)
    second = cache.get("key", lambda: calls.append(2) or "wrong")
    passed &= first == value and second == value and calls == [1]
print(json.dumps({"passed": bool(passed), "tests": 4}))
sys.exit(0 if passed else 1)
