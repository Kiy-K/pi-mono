"""Migrate JSON config files from v1 to v2. Required behavior: SPEC.md."""
import json
import os


def migrate(workspace: str) -> dict[str, int]:
    """Migrate all .json files in workspace from v1 to v2 schema."""
    raise NotImplementedError("implement per SPEC.md")