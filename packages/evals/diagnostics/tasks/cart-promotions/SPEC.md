# Promotion Engine Specification

All money values are integer cents. All behavior in this specification is
normative: the public API must behave exactly as described here, including the
error cases, even where `test_promotions.py` does not check them.

## Module `promotions.py`

### `percentage_discount(cart, percent) -> int`

- Computes the discount for `percent` percent off the cart.
- The discount is computed **per cart line**, then summed:
  `line_discount = round_half_up(line_total_cents * percent / 100)` where
  `line_total_cents = unit_price_cents * quantity`. Halfway values round up
  (e.g. 2.5 becomes 3).
- `percent` must be an int or float satisfying `0 < percent <= 100`; otherwise
  raise `PromotionError` with the message `"percent must be in (0, 100]"`.
- An empty cart returns 0.

### `buy_x_get_y_free(cart, sku, x, y) -> int`

- Applies to the single cart line whose sku matches. For every full group of
  `x + y` units in that line, `y` units are free, so:
  `groups = quantity // (x + y)` and
  `discount = groups * y * unit_price_cents`.
- Remainder units (`quantity % (x + y)`) are never discounted.
- If the sku is not in the cart, the discount is 0 (no error).
- `x >= 1` and `y >= 1` are required; otherwise raise `PromotionError` with
  the message `"x and y must be >= 1"`.

### `apply_promotions(cart, promotions) -> PromotionResult`

- `promotions` is a list of tuples, either `("percent", percent)` or
  `("bogo", sku, x, y)`, applied in list order.
- At most one `("percent", ...)` promotion may appear. Two or more raise
  `PromotionError` with the message `"percentage promotions are exclusive"`.
- Every discount is computed against the original, unmodified cart. Discounts
  do not cascade.
- `total_discount_cents = min(sum of all discounts, cart.subtotal_cents())`
  (the discount is capped at the subtotal; it can never be negative).
- Returns `PromotionResult(lines, total_discount_cents)` where `lines` is a
  list of `PromotionLine(description, discount_cents)` in promotion order:
  - percentage: description `f"{percent}% OFF"`
  - bogo: description `f"BOGO {sku} ({x}+{y})"`
  Tuple members must use the exact literal formats above.
- An empty promotions list returns `PromotionResult(lines=[], total_discount_cents=0)`.
- `PromotionError` subclasses `ValueError` and is defined in `promotions.py`.
- The function must not mutate the cart.

## Module `receipt.py`

### `format_receipt_with_promotions(cart, promotions) -> str`

Exact line sequence (literal separators, no padding, no trailing spaces):

```
RECEIPT
{name} x{quantity} @{unit_price_cents}c = {line_total_cents}c
SUBTOTAL: {subtotal}c
PROMOTIONS
{description}: -{discount_cents}c
TOTAL: {subtotal - total_discount_cents}c
```

- One `{name} x...` line per cart line, in cart insertion order.
- One `{description}: -...` line per promotion, in promotion order, using the
  same `apply_promotions` result (including the subtotal cap).
- When `promotions` is empty the `PROMOTIONS` section and its lines are
  omitted entirely, and `TOTAL` equals `SUBTOTAL`.
- The existing `format_receipt(cart)` behavior must remain unchanged.

## Module `cart.py`

`cart.py` is already complete and must not change its public behavior:
`Cart.add_item`, `Cart.remove_item`, `Cart.items`, `Cart.subtotal_cents`,
`CartError`, and the `Item` dataclass keep their current contracts.
