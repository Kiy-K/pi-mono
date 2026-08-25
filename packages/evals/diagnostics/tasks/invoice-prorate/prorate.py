"""Payment allocation. The required behavior is specified in SPEC.md."""

from invoice import Invoice


class PaymentError(ValueError):
    """Raised for invalid payments."""


def allocate_payment(invoice: Invoice, payment_cents: int) -> list[int]:
    """Split payment_cents across invoice lines, per SPEC.md."""
    raise NotImplementedError("implement per SPEC.md")
