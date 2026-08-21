"""Plain-text receipts. The extended format is specified in SPEC.md."""

from cart import Cart


def format_receipt(cart: Cart) -> str:
    lines = ["RECEIPT"]
    for item in cart.items():
        line_total = item.unit_price_cents * item.quantity
        lines.append(f"{item.name} x{item.quantity} @{item.unit_price_cents}c = {line_total}c")
    lines.append(f"SUBTOTAL: {cart.subtotal_cents()}c")
    return "\n".join(lines)


def format_receipt_with_promotions(cart: Cart, promotions: list) -> str:
    """Receipt including the promotion section, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")
