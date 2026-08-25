/**
 * SPEC-faithful matching-engine reference source and the violating-mutant
 * catalog, shared by the verifier-attribution suite and the verification-
 * signal characterization. Each mutant is one plausible wrong rule applied to
 * REFERENCE; every mutant must be rejected by the external verifier.
 */

export const REFERENCE = `"""Matching engine per SPEC.md."""
import itertools


class Order:
    def __init__(self, order_id, side, price, qty):
        self.order_id = order_id
        self.side = side
        self.price = price
        self.qty = qty

    def __eq__(self, other):
        return isinstance(other, Order) and (self.order_id, self.side, self.price, self.qty) == (
            other.order_id, other.side, other.price, other.qty)

    def __repr__(self):
        return f"Order({self.order_id},{self.side!r},{self.price},{self.qty})"


class Trade:
    def __init__(self, buy_id, sell_id, price, qty):
        self.buy_id = buy_id
        self.sell_id = sell_id
        self.price = price
        self.qty = qty

    def __eq__(self, other):
        return isinstance(other, Trade) and (self.buy_id, self.sell_id, self.price, self.qty) == (
            other.buy_id, other.sell_id, other.price, other.qty)

    def __repr__(self):
        return f"Trade({self.buy_id},{self.sell_id},{self.price},{self.qty})"


class MatchingEngine:
    def __init__(self):
        self._orders = {}
        self._bids = {}
        self._asks = {}
        self._seq = itertools.count()

    def submit(self, order):
        if order.price < 1 or order.qty < 1:
            raise ValueError("price and qty must be >= 1")
        if order.order_id in self._orders:
            raise ValueError("duplicate order id")
        trades = []
        book = self._bids if order.side == "buy" else self._asks
        opposing = self._asks if order.side == "buy" else self._bids
        remaining = order.qty
        opp_side = "sell" if order.side == "buy" else "buy"
        while remaining > 0:
            best = None
            for oid, o in opposing.items():
                if o["qty"] <= 0:
                    continue
                if order.side == "buy" and o["price"] > order.price:
                    continue
                if order.side == "sell" and o["price"] < order.price:
                    continue
                if best is None or (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"]):
                    best = (oid, o)
            if best is None:
                break
            oid, o = best
            fill = min(remaining, o["qty"])
            trades.append(Trade(order.order_id if order.side == "buy" else oid,
                                oid if order.side == "buy" else order.order_id,
                                o["price"], fill))
            o["qty"] -= fill
            remaining -= fill
            if o["qty"] == 0:
                del opposing[oid]
        if remaining > 0:
            self._orders[order.order_id] = {"side": order.side, "price": order.price,
                                            "qty": remaining, "seq": next(self._seq)}
            book[order.order_id] = self._orders[order.order_id]
        return trades

    def cancel(self, order_id):
        o = self._orders.get(order_id)
        if o is None or o["qty"] <= 0:
            return False
        o["qty"] = 0
        del self._orders[order_id]
        self._bids.pop(order_id, None)
        self._asks.pop(order_id, None)
        return True

    def book(self):
        bids = [Order(oid, "buy", o["price"], o["qty"])
                for oid, o in sorted(self._bids.items(), key=lambda kv: (-kv[1]["price"], kv[1]["seq"]))
                if o["qty"] > 0]
        asks = [Order(oid, "sell", o["price"], o["qty"])
                for oid, o in sorted(self._asks.items(), key=lambda kv: (kv[1]["price"], kv[1]["seq"]))
                if o["qty"] > 0]
        return bids, asks

    def state(self):
        return sum(1 for o in self._orders.values() if o["qty"] > 0)
`;

export function applyFindReplace(source: string, find: string, replace: string): string {
	if (!source.includes(find)) throw new Error(`anchor not found: ${find.slice(0, 50)}...`);
	return source.replace(find, replace);
}

/** Invert time priority for one aggressor side only. */
function sideInversion(aggressor: "buy" | "sell"): string {
	const find = 'if best is None or (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"]):';
	const replace =
		aggressor === "buy"
			? `if best is None or (order.side == "${aggressor}" and [o["price"], -o["seq"]] < [best[1]["price"], -best[1]["seq"]]) or (order.side != "${aggressor}" and (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"])):\n                    best = (oid, o)`
			: `if best is None or (order.side == "${aggressor}" and [o["price"], -o["seq"]] < [best[1]["price"], -best[1]["seq"]]) or (order.side != "${aggressor}" and (o["price"], o["seq"]) < (best[1]["price"], best[1]["seq"])):\n                    best = (oid, o)`;
	if (!REFERENCE.includes(find)) throw new Error("comparator anchor missing");
	return REFERENCE.replace(find, `${replace}`);
}

/** name -> mutated engine source. */
export const MUTANTS: Record<string, () => string> = {
	sell_side_fifo_inverted: () => sideInversion("buy"),
	buy_side_fifo_inverted: () => sideInversion("sell"),
	trade_at_aggressor_price: () =>
		applyFindReplace(
			REFERENCE,
			'                                o["price"], fill))',
			"                                order.price, fill))",
		),
	no_crossing_check: () =>
		applyFindReplace(
			REFERENCE,
			'                if order.side == "buy" and o["price"] > order.price:\n                    continue',
			"                pass",
		),
	buy_book_sorted_ascending: () =>
		applyFindReplace(
			REFERENCE,
			'key=lambda kv: (-kv[1]["price"], kv[1]["seq"])',
			'key=lambda kv: (kv[1]["price"], kv[1]["seq"])',
		),
	wrong_bound_message: () =>
		applyFindReplace(
			REFERENCE,
			'raise ValueError("price and qty must be >= 1")',
			'raise ValueError("invalid order")',
		),
	cancel_not_reusable: () =>
		applyFindReplace(
			REFERENCE,
			'        o["qty"] = 0\n        del self._orders[order_id]\n',
			'        o["qty"] = 0\n',
		),
	duplicate_check_removed: () =>
		applyFindReplace(
			REFERENCE,
			'        if order.order_id in self._orders:\n            raise ValueError("duplicate order id")\n',
			"",
		),
};
