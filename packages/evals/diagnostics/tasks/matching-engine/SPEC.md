# Matching Engine Specification

All behavior in this specification is normative: the public API must behave
exactly as described here, including for combinations not shown in the worked
examples.

## Concepts

Orders are limit orders with a side (`"buy"` or `"sell"`), an integer price,
an integer quantity, and a unique `order_id`. The engine matches buy orders
against resting sell orders and sell orders against resting buy orders.

- **Crossing:** a buy order with price `pb` and a sell order with price `ps`
  cross (can trade) iff `pb >= ps`.
- **Price-time priority:** on each side, orders are matched by best price
  first, then by arrival time (earlier first). A buy at a higher price is
  better; a sell at a lower price is better. Ties in price break by arrival
  order (FIFO).
- **Aggressor vs. resting:** the order passed to `submit` is the aggressor.
  It is matched against opposing-side orders already resting in the book. The
  resting (already-booked) order's price is always the trade price.
- **Maker price:** the trade price for any match is the resting order's price,
  never the aggressor's price.

## Data types

- `Order(order_id: int, side: str, price: int, qty: int)` — an immutable order
  descriptor.
- `Trade(buy_id: int, sell_id: int, price: int, qty: int)` — one completed
  trade record. `buy_id`/`sell_id` are the two participating order ids;
  `price` is the maker (resting) price; `qty` is the executed quantity.

Both are plain classes with those attribute names.

## `MatchingEngine`

A `MatchingEngine` is initialized with no arguments. It assigns arrival
sequence numbers internally; the arrival sequence of a submitted order is the
order in which its `submit` call is made (1, 2, 3, ..., across all orders,
never reset).

### `submit(order: Order) -> list[Trade]`

1. If an order with the same `order_id` already exists in the book (resting)
   or the same `order_id` was previously submitted and not fully cancelled,
   raise `ValueError` with the message `"duplicate order id"`. (See cancel
   rules below for when an id is freed.)
2. Treat the new order as the aggressor. While the aggressor has remaining
   quantity AND there exists a resting opposing-side order it crosses with,
   repeat:
   - pick the best opposing-side resting order by price-time priority;
   - if `aggressor.qty_remaining == 0`, stop;
   - `trade_qty = min(aggressor.qty_remaining, resting.qty_remaining)`;
   - execute a trade at `resting.price` for `trade_qty`;
   - reduce both remaining quantities by `trade_qty`;
   - if the resting order's remaining quantity reaches 0, remove it from the
     book (it is fully filled);
   - if the aggressor's remaining quantity reaches 0, stop.
3. If the aggressor has remaining quantity after matching, it rests in the
   book on its own side.
4. Return the list of `Trade` records in the exact order the trades executed.

### `cancel(order_id: int) -> bool`

- If `order_id` refers to an order currently resting in the book, remove it
  entirely (its remaining quantity no longer participates) and return `True`.
- Otherwise (id not resting), return `False`. Cancelling an order that is not
  currently in the book does not raise.
- Fully-filled aggressor orders leave the book automatically; their ids are
  NOT freed for reuse (see submit rule 1).
- A cancelled id IS freed for reuse: after `cancel` returns `True`, a later
  `submit` may reuse that `order_id`.

### `book() -> tuple[list[Order], list[Order]]`

- Returns `(buy_orders, sell_orders)`, the resting orders of each side.
- Within each list, orders are ordered by price-time priority: `buy_orders`
  descending price (best/highest first); `sell_orders` ascending price
  (best/lowest first).
- Manifested `Order`s carry the original `price` and the **remaining**
  quantity. An order that was partially filled has `qty` equal to its
  remaining (unfilled) quantity.

### `state() -> int`

- Returns the number of resting orders currently in the book (buys + sells).

## Error handling

- Reusing a live `order_id` raises `ValueError("duplicate order id")` (see
  submit rule 1).
- Prices and quantities must be `>= 1` for both sides; otherwise raise
  `ValueError` with message `"price and qty must be >= 1"`.

## Worked examples

### Example A: single crossing fill (buyer aggressor, maker sell)

Book after `submit(Order(1,"sell",100,5))`: sells = `[Order(1,"sell",100,5)]`,

`submit(Order(2,"buy",100,3))`:
- aggressor buy 100x3 crosses resting sell 100x5 (100 >= 100).
- `trade_qty = min(3,5) = 3`; trade at resting price 100 for qty 3.
- resting sell remains 2, rests.
- aggressor qty 0, stops.
- returns `[Trade(2, 1, 100, 3)]`.
- book now: buys `[]`, sells `[Order(1,"sell",100,2)]`.

### Example B: multi-level fill (aggressor consumes several resting orders)

`submit(Order(10,"sell",99,2))`, `submit(Order(11,"sell",98,4))`,

`submit(Order(12,"buy",100,5))`:
- best resting sell is 11 at 98 (lower price = better), qty 4; matches 4 at
  98 (maker price). Trade `Trade(12,11,98,4)`.
- aggressor remaining 1; next resting sell is 10 at 99; matches 1 at 99.
  Trade `Trade(12,10,99,1)`.
- aggressor qty 0. Returns `[Trade(12,11,98,4), Trade(12,10,99,1)]`.
- sell 11 (98) fully filled; sell 10 (99) had qty 2, filled 1, so 1 remains.
- book: sells `[Order(10,"sell",99,1)]`.

### Example C: partial-fill remainder rests (price-time priority)

`submit(Order(20,"buy",95,10))`, `submit(Order(21,"buy",95,2))`,

`submit(Order(22,"sell",95,5))`:
- resting buys sorted by price-time priority: 20 (10) before 21 (2) — both
  price 95, arrival FIFO.
- aggressor sell 95x5 matches 20 first: `min(5,10)=5` at maker 95.
  Trade `Trade(20,22,95,5)`. Aggressor qty 0. Stops.
- returns `[Trade(20,22,95,5)]`.
- book: buys `[Order(20,"buy",95,5), Order(21,"buy",95,2)]` (20 has 5
  remaining, still earlier priority), sells `[]`.

### Example D: cancel

`submit(Order(30,"buy",100,7))`, `cancel(30)` -> `True`, `book()` buys `[]`,
`cancel(30)` again -> `False` (no longer resting). `submit(Order(30,"buy",90,1))`
reuses id 30 (it was freed).