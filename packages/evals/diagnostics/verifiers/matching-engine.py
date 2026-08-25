#!/usr/bin/env python3
"""External verifier for matching-engine. Every check derives only from the
SPEC text (crossing  pb>=ps; price-time priority; maker price = resting price;
cancel frees id; book ordering; bound ValueError message). No reference engine
is consulted."""
import io
import json
import pathlib
import sys
import unittest
from _common import load_module

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))


def load(name):
    return load_module(root, name)


engine = load("engine")

failures = []
total = 0


def check(name, fn):
    global total
    total += 1
    try:
        fn()
    except Exception as error:
        failures.append(f"{name}: {type(error).__name__}: {error}")


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_raises_msg(fn, msg, label):
    try:
        fn()
    except ValueError as error:
        if str(error) != msg:
            raise AssertionError(f"{label}: message {str(error)!r}, expected {msg!r}")
        return
    raise AssertionError(f"{label}: ValueError not raised")


# Reconstruct the scenario from Example B and re-assert exact output.
def example_b_matches():
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(10, "sell", 99, 2))
    eng.submit(engine.Order(11, "sell", 98, 4))
    trades = eng.submit(engine.Order(12, "buy", 100, 5))
    assert_equal(trades, [engine.Trade(12, 11, 98, 4), engine.Trade(12, 10, 99, 1)], "Example B trades")
    buys, sells = eng.book()
    assert_equal(sells, [engine.Order(10, "sell", 99, 1)], "Example B sell 10 remainder rests")


check("example B exact trade sequence", example_b_matches)


def maker_price_never_aggressor():
    # Resting sell at 50; aggressive buy at 100 must trade at 50, not 100.
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(1, "sell", 50, 4))
    trades = eng.submit(engine.Order(2, "buy", 100, 4))
    assert_equal(trades, [engine.Trade(2, 1, 50, 4)], "maker price")
    assert_equal(eng.state(), 0, "fully filled")


check("trade at maker price not aggressor price", maker_price_never_aggressor)


def no_crossing_when_price_below():
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(1, "sell", 100, 5))
    trades = eng.submit(engine.Order(2, "buy", 99, 3))
    assert_equal(trades, [], "buy below sell no cross")
    buys, sells = eng.book()
    assert_equal(buys, [engine.Order(2, "buy", 99, 3)], "buyer rests")
    assert_equal(sells, [engine.Order(1, "sell", 100, 5)], "seller unchanged")


check("no crossing below price", no_crossing_when_price_below)


def book_priority_ordering():
    eng = engine.MatchingEngine()
    # Mix of resting buys and sells without crossing.
    eng.submit(engine.Order(10, "sell", 110, 1))
    eng.submit(engine.Order(11, "buy", 95, 1))
    eng.submit(engine.Order(12, "buy", 98, 1))
    eng.submit(engine.Order(13, "sell", 105, 1))
    buys, sells = eng.book()
    assert_equal([o.price for o in buys], [98, 95], "buys descending price")
    assert_equal([o.price for o in sells], [105, 110], "sells ascending price")
    assert_equal([o.qty for o in buys], [1, 1], "buy qtys preserved")


check("book orders by price-time priority", book_priority_ordering)


def same_price_fifo_both_sides():
    """SPEC price-time priority: equal prices fill in arrival order, each side."""
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(30, "sell", 50, 3))
    eng.submit(engine.Order(31, "sell", 50, 4))
    trades = eng.submit(engine.Order(32, "buy", 60, 5))
    assert_equal(
        trades,
        [engine.Trade(32, 30, 50, 3), engine.Trade(32, 31, 50, 2)],
        "sell side fills earliest first",
    )
    eng.submit(engine.Order(33, "sell", 60, 1))
    eng.submit(engine.Order(34, "buy", 40, 6))
    eng.submit(engine.Order(35, "buy", 40, 7))
    trades = eng.submit(engine.Order(36, "sell", 35, 8))
    assert_equal(
        trades,
        [engine.Trade(34, 36, 40, 6), engine.Trade(35, 36, 40, 2)],
        "buy side fills earliest first",
    )
    buys, sells = eng.book()
    assert_equal(buys, [engine.Order(35, "buy", 40, 5)], "later buy remainder rests")


check("same-price orders fill in arrival order on both sides", same_price_fifo_both_sides)


def cancel_frees_id_for_reuse():
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(7, "buy", 100, 5))
    assert_equal(eng.cancel(7), True, "cancel resting")
    assert_equal(eng.cancel(7), False, "cancel again false")
    trades = eng.submit(engine.Order(7, "buy", 90, 2))
    assert_equal(trades, [], "reused id trades nothing")
    assert_equal(eng.state(), 1, "reused id resting")


check("cancelled id reusable", cancel_frees_id_for_reuse)


def fully_filled_id_not_reusable():
    eng = engine.MatchingEngine()
    eng.submit(engine.Order(1, "sell", 100, 5))
    eng.submit(engine.Order(2, "buy", 100, 5))  # fully fills id 1
    try:
        eng.submit(engine.Order(1, "buy", 100, 1))
    except ValueError as err:
        if "duplicate order id" not in str(err):
            raise AssertionError(f"duplicate message: {str(err)!r}")
    else:
        raise AssertionError("fully-filled id must not be reusable")


check("fully-filled id not reused", fully_filled_id_not_reusable)


def bound_validation_message():
    eng = engine.MatchingEngine()
    assert_raises_msg(lambda: eng.submit(engine.Order(1, "buy", 0, 5)), "price and qty must be >= 1", "price 0")
    assert_raises_msg(lambda: eng.submit(engine.Order(2, "sell", 100, 0)), "price and qty must be >= 1", "qty 0")


check("price/qty >= 1 with exact message", bound_validation_message)


def long_sequence_invariants():
    eng = engine.MatchingEngine()
    # Build a book then sweep with an aggressor; check conservation + priority.
    eng.submit(engine.Order(1, "sell", 100, 3))
    eng.submit(engine.Order(2, "sell", 98, 2))
    eng.submit(engine.Order(3, "buy", 95, 4))
    eng.submit(engine.Order(4, "buy", 97, 1))
    trades = eng.submit(engine.Order(5, "buy", 120, 4))
    # Aggressor buy 120x4: best sell is 98 (2) then 100 (3). Trades: 98x2, 100x2.
    expected = [engine.Trade(5, 2, 98, 2), engine.Trade(5, 1, 100, 2)]
    assert_equal(trades, expected, "priority consumption")
    buys, sells = eng.book()
    # 95x4 (buy) and 97x1 (buy) rest, plus sell 100 with 1 remaining.
    assert_equal([o.qty for o in buys], [1, 4], "resting buys after sweep")
    assert_equal([o.qty for o in sells], [1], "resting sell after sweep")


check("long sequence conservation + priority", long_sequence_invariants)


# Public suite must also pass.
module = load("test_engine")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in result.failures + result.errors:
    failures.append(f"test_engine.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)