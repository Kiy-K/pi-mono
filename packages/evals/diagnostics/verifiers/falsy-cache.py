#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "cache.py"
spec = importlib.util.spec_from_file_location("cache", path)
module = importlib.util.module_from_spec(spec)
sys.modules["cache"] = module  # dataclasses resolves cls.__module__ via sys.modules; `from __future__ import annotations` submissions crash without this
spec.loader.exec_module(module)
passed = True
for value in (0, False, "", None):
    calls = []
    cache = module.Cache()
    first = cache.get("key", lambda: calls.append(1) or value)
    second = cache.get("key", lambda: calls.append(2) or "wrong")
    passed &= first == value and second == value and calls == [1]
print(json.dumps({"passed": bool(passed), "tests": 4}))
sys.exit(0 if passed else 1)
