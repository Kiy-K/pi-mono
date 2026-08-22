"""Caching replica with stale detection. Required behavior: SPEC.md."""

from store import Store


class Replica:
    def __init__(self, store: Store) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def read(self, key: str) -> tuple[str, int] | None:
        raise NotImplementedError("implement per SPEC.md")

    def invalidate(self, key: str) -> bool:
        raise NotImplementedError("implement per SPEC.md")

    def pending(self) -> list[str]:
        raise NotImplementedError("implement per SPEC.md")
