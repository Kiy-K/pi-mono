from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


class Cache:
    def __init__(self) -> None:
        self._values: dict[str, object] = {}

    def get(self, key: str, load: Callable[[], T]) -> T:
        if value := self._values.get(key):
            return value  # type: ignore[return-value]
        value = load()
        self._values[key] = value
        return value
