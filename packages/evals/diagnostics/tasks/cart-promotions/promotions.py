"""Promotion engine. The required behavior is specified in SPEC.md."""

from dataclasses import dataclass

from cart import Cart


class PromotionError(ValueError):
    """Raised for invalid promotions."""


@dataclass(frozen=True)
class PromotionLine:
    description: str
    discount_cents: int


@dataclass(frozen=True)
class PromotionResult:
    lines: list[PromotionLine]
    total_discount_cents: int


def percentage_discount(cart: Cart, percent: int | float) -> int:
    """Return the discount in cents for percent percent off, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")


def buy_x_get_y_free(cart: Cart, sku: str, x: int, y: int) -> int:
    """Return the discount in cents for buy-x-get-y-free on sku, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")


def apply_promotions(cart: Cart, promotions: list) -> PromotionResult:
    """Apply promotions in order and return a PromotionResult, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")
