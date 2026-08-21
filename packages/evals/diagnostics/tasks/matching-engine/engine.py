"""Matching engine. Required behavior is specified in SPEC.md."""


class Order:
    def __init__(self, order_id: int, side: str, price: int, qty: int) -> None:
        self.order_id = order_id
        self.side = side
        self.price = price
        self.qty = qty

    def __eq__(self, other) -> bool:
        return isinstance(other, Order) and (self.order_id, self.side, self.price, self.qty) == \
            (other.order_id, other.side, other.price, other.qty)

    def __repr__(self) -> str:
        return f"Order({self.order_id},{self.side!r},{self.price},{self.qty})"


class Trade:
    def __init__(self, buy_id: int, sell_id: int, price: int, qty: int) -> None:
        self.buy_id = buy_id
        self.sell_id = sell_id
        self.price = price
        self.qty = qty

    def __eq__(self, other) -> bool:
        return isinstance(other, Trade) and (self.buy_id, self.sell_id, self.price, self.qty) == \
            (other.buy_id, other.sell_id, other.price, other.qty)

    def __repr__(self) -> str:
        return f"Trade({self.buy_id},{self.sell_id},{self.price},{self.qty})"


class MatchingEngine:
    def __init__(self) -> None:
        raise NotImplementedError("implement per SPEC.md")

    def submit(self, order: Order) -> list[Trade]:
        raise NotImplementedError("implement per SPEC.md")

    def cancel(self, order_id: int) -> bool:
        raise NotImplementedError("implement per SPEC.md")

    def book(self) -> tuple[list[Order], list[Order]]:
        raise NotImplementedError("implement per SPEC.md")

    def state(self) -> int:
        raise NotImplementedError("implement per SPEC.md")