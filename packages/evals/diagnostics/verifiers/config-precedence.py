#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "config.py"
spec = importlib.util.spec_from_file_location("config", path)
module = importlib.util.module_from_spec(spec)
sys.modules["config"] = module  # dataclasses resolves cls.__module__ via sys.modules; `from __future__ import annotations` submissions crash without this
spec.loader.exec_module(module)
resolved = module.resolve_config(
    {"only_default": 1, "shared": "default"},
    {"only_file": 2, "shared": "file"},
    {"only_env": 3, "shared": "env"},
    {"only_cli": 4, "shared": "cli"},
)
expected = {
    "only_default": 1,
    "only_file": 2,
    "only_env": 3,
    "only_cli": 4,
    "shared": "cli",
}
passed = resolved == expected
print(json.dumps({"passed": passed, "tests": 5}))
sys.exit(0 if passed else 1)
