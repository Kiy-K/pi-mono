"""Event store with persistence. Required behavior: SPEC.md."""
import json
import os


class EventStore:
    def __init__(self, db_path: str) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def apply(self, events: list[dict]) -> dict:
        raise NotImplementedError("implement per SPEC.md")

    def get(self, key: str) -> str | None:
        raise NotImplementedError("implement per SPEC.md")

    def keys(self) -> list[str]:
        raise NotImplementedError("implement per SPEC.md")

    def verify(self) -> bool:
        raise NotImplementedError("implement per SPEC.md")