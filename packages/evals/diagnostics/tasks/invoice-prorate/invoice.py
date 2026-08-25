"""Invoice with integer-cent line amounts."""

from dataclasses import dataclass


@dataclass(frozen=True)
class InvoiceLine:
    sku: str
    name: str
    amount_cents: int


class InvoiceError(ValueError):
    """Raised for invalid invoice operations."""


class Invoice:
    """Insertion-ordered invoice of positive-amount lines."""

    def __init__(self) -> None:
        self._lines: dict[str, InvoiceLine] = {}

    def add_line(self, sku: str, name: str, amount_cents: int) -> None:
        """Add a line; skus are unique and amounts must be positive."""
        if sku in self._lines:
            raise InvoiceError(f"duplicate sku: {sku}")
        if amount_cents <= 0:
            raise InvoiceError(f"amount_cents must be > 0, got {amount_cents}")
        self._lines[sku] = InvoiceLine(sku, name, amount_cents)

    def lines(self) -> list[InvoiceLine]:
        """Lines in insertion order."""
        return list(self._lines.values())

    def total_cents(self) -> int:
        """Sum of amount_cents over all lines."""
        return sum(line.amount_cents for line in self._lines.values())
