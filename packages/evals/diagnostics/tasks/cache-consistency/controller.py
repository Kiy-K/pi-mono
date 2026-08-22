"""Batch sync orchestrator. Required behavior: SPEC.md."""

from replica import Replica
from store import Store


class Controller:
    def __init__(self, store: Store, replica: Replica) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def sync(self, updates: dict[str, str]) -> dict:
        raise NotImplementedError("implement per SPEC.md")

    def audit(self) -> dict:
        raise NotImplementedError("implement per SPEC.md")
