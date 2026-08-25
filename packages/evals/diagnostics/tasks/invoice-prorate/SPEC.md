# Payment Allocation Specification

All money values are integer cents. All behavior in this specification is
normative: the public API must behave exactly as described here, including the
error cases, even where `test_prorate.py` does not check them.

## Module `invoice.py`

`invoice.py` is already complete and must not change its public behavior:
`Invoice.add_line`, `Invoice.lines`, `Invoice.total_cents`, `InvoiceError`,
and the `InvoiceLine` dataclass keep their current contracts.

## Module `prorate.py`

### `allocate_payment(invoice, payment_cents) -> list[int]`

Splits a payment across the invoice's lines proportionally to their
`amount_cents`, using the **largest remainder method** with exact integer
arithmetic:

1. Let `total = invoice.total_cents()` and `lines = invoice.lines()`.
2. For each line `i` (insertion order), the exact share is the rational
   `payment_cents * amount_i / total`. Set
   `base_i = floor(payment_cents * amount_i / total)` and note the remainder
   `frac_i = (payment_cents * amount_i) mod total`.
3. Let `leftover = payment_cents - sum(base_i)`. Distribute `leftover` cents,
   one cent at a time, to the lines with the largest `frac_i`; ties are broken
   by lower line index (insertion order). Each line gains at most one cent.
4. Return the allocation as a list of ints in line order. The allocation must
   always sum to exactly `payment_cents`.

Validation, in this order:

- `payment_cents` must be an `int` (`bool` is not an int); otherwise raise
  `PaymentError` with the message `"payment must be an integer number of
  cents"`. Floats such as `100.0` are rejected.
- `0 <= payment_cents <= total`; otherwise raise `PaymentError` with the
  message `"payment out of range"`.
- An invoice with no lines has `total == 0`; `payment_cents == 0` returns
  `[]` (and no other payment is valid for it).

`PaymentError` subclasses `ValueError` and is defined in `prorate.py`.

The function must not mutate the invoice.
