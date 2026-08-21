"""Append-only JSONL journal."""

import json
from pathlib import Path


class Journal:
    def __init__(self, path: str) -> None:
        self.path = Path(path)

    def append(self, entry: dict) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        entries = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                entries.append(json.loads(line))
        return entries

    def size_bytes(self) -> int:
        if not self.path.exists():
            return 0
        return self.path.stat().st_size
