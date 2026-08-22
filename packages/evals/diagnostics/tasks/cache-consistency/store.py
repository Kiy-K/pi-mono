"""Authoritative versioned store. Required behavior: SPEC.md."""


class Store:
    def __init__(self) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def put(self, key: str, value: str) -> int:
        raise NotImplementedError("implement per SPEC.md")

    def get(self, key: str) -> tuple[str, int] | None:
        raise NotImplementedError("implement per SPEC.md")

    def keys(self) -> list[str]:
        raise NotImplementedError("implement per SPEC.md")
