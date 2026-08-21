"""Shopping cart with integer-cent prices."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    unit_price_cents: int
    quantity: int


class CartError(ValueError):
    """Raised for invalid cart operations."""


class Cart:
    """Insertion-ordered cart of quantified items."""

    def __init__(self) -> None:
        self._items: dict[str, Item] = {}

    def add_item(self, sku: str, name: str, unit_price_cents: int, quantity: int = 1) -> None:
        """Add quantity units of sku, merging into an existing line."""
        if quantity < 1:
            raise CartError(f"quantity must be >= 1, got {quantity}")
        if unit_price_cents < 0:
            raise CartError(f"unit_price_cents must be >= 0, got {unit_price_cents}")
        if sku in self._items:
            existing = self._items[sku]
            self._items[sku] = Item(
                existing.sku,
                existing.name,
                existing.unit_price_cents,
                existing.quantity + quantity,
            )
        else:
            self._items[sku] = Item(sku, name, unit_price_cents, quantity)

    def remove_item(self, sku: str, quantity: int | None = None) -> None:
        """Remove quantity units of sku; None removes the whole line."""
        if sku not in self._items:
            raise CartError(f"unknown sku: {sku}")
        existing = self._items[sku]
        if quantity is None:
            del self._items[sku]
            return
        if quantity < 1:
            raise CartError(f"quantity must be >= 1, got {quantity}")
        if quantity > existing.quantity:
            raise CartError(f"cannot remove {quantity} of {existing.sku}, only {existing.quantity} in cart")
        if quantity == existing.quantity:
            del self._items[sku]
        else:
            self._items[sku] = Item(
                existing.sku,
                existing.name,
                existing.unit_price_cents,
                existing.quantity - quantity,
            )

    def items(self) -> list[Item]:
        """Lines in insertion order."""
        return list(self._items.values())

    def subtotal_cents(self) -> int:
        """Sum of unit_price_cents * quantity over all lines."""
        return sum(item.unit_price_cents * item.quantity for item in self._items.values())
