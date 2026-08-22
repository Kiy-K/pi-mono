"""Transactional KV store with snapshot isolation and savepoints. Required behavior: SPEC.md."""


class TxnKV:
    def __init__(self) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def set(self, key: str, value: str) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def get(self, key: str) -> str | None:
        raise NotImplementedError("implement per SPEC.md")

    def delete(self, key: str) -> bool:
        raise NotImplementedError("implement per SPEC.md")

    def begin(self) -> int:
        raise NotImplementedError("implement per SPEC.md")

    def commit(self, txn: int) -> dict:
        raise NotImplementedError("implement per SPEC.md")

    def rollback(self, txn: int) -> dict:
        raise NotImplementedError("implement per SPEC.md")

    def savepoint(self, txn: int) -> str:
        raise NotImplementedError("implement per SPEC.md")

    def rollback_to(self, txn: int, sp: str) -> dict:
        raise NotImplementedError("implement per SPEC.md")
