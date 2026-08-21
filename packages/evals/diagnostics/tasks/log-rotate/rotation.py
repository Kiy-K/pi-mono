"""Journal rotation. The required behavior is specified in SPEC.md."""

from journal import Journal


class RotationError(ValueError):
    """Raised for invalid rotation parameters."""


def should_rotate(path: str, max_bytes: int) -> bool:
    """Return whether the journal at path needs rotation, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")


def rotate(path: str, keep: int) -> list[str]:
    """Shift rotated files up by one and rotate the active journal, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")


def append_with_rotation(journal: Journal, entry: dict, max_bytes: int, keep: int) -> list[str]:
    """Append an entry, rotating first when needed, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")
