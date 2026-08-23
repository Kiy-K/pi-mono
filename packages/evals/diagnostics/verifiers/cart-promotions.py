#!/usr/bin/env python3
"""External verifier for the cart-promotions task: enforces every SPEC.md rule,
including edge cases the bundled tests do not cover."""
import importlib.util
import io
import json
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))


def load(name):
    spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


promotions = load("promotions")
receipt = load("receipt")
cart_mod = load("cart")

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


def assert_message(fn, expected, label):
    try:
        fn()
    except promotions.PromotionError as error:
        assert_equal(str(error), expected, f"{label} message")
        return
    raise AssertionError(f"{label}: PromotionError not raised")


def fresh_cart():
    cart = cart_mod.Cart()
    cart.add_item("a", "Apple", 150, 1)
    cart.add_item("b", "Banana", 250, 1)
    return cart


# percentage_discount: per-line round-half-up.
def percentage_rounds_half_up_per_line():
    assert_equal(promotions.percentage_discount(fresh_cart(), 5), 8 + 13, "150+250 at 5%")

check("percentage rounds half-up per line", percentage_rounds_half_up_per_line)


def percentage_float_allowed():
    single = cart_mod.Cart()
    single.add_item("a", "Apple", 200, 1)
    assert_equal(promotions.percentage_discount(single, 12.5), 25, "200 at 12.5%")

check("percentage accepts float percents", percentage_float_allowed)


def percentage_zero_rejected():
    assert_message(lambda: promotions.percentage_discount(fresh_cart(), 0), "percent must be in (0, 100]", "percent 0")

check("percent 0 rejected", percentage_zero_rejected)


def percentage_over_100_rejected():
    assert_message(lambda: promotions.percentage_discount(fresh_cart(), 101), "percent must be in (0, 100]", "percent 101")

check("percent 101 rejected", percentage_over_100_rejected)


def percentage_non_numeric_rejected():
    """SPEC: percent must be int or float; anything else raises PromotionError."""
    assert_message(lambda: promotions.percentage_discount(fresh_cart(), "50"), "percent must be in (0, 100]", "str percent")
    assert_message(lambda: promotions.percentage_discount(fresh_cart(), None), "percent must be in (0, 100]", "None percent")


check("non-numeric percent rejected with PromotionError", percentage_non_numeric_rejected)


def percentage_empty_cart():
    assert_equal(promotions.percentage_discount(cart_mod.Cart(), 10), 0, "empty cart")

check("percentage on empty cart is 0", percentage_empty_cart)


# buy_x_get_y_free: full groups only.
def bogo_remainder_not_discounted():
    cart = cart_mod.Cart()
    cart.add_item("a", "Apple", 300, 7)
    assert_equal(promotions.buy_x_get_y_free(cart, "a", 2, 1), 2 * 300, "7 units of buy-2-get-1")

check("bogo ignores remainder units", bogo_remainder_not_discounted)


def bogo_unknown_sku_is_zero():
    cart = cart_mod.Cart()
    cart.add_item("a", "Apple", 300, 3)
    assert_equal(promotions.buy_x_get_y_free(cart, "missing", 2, 1), 0, "unknown sku")

check("bogo on unknown sku is 0", bogo_unknown_sku_is_zero)


def bogo_invalid_x_rejected():
    assert_message(lambda: promotions.buy_x_get_y_free(cart_mod.Cart(), "a", 0, 1), "x and y must be >= 1", "x=0")

check("bogo x=0 rejected", bogo_invalid_x_rejected)


def bogo_invalid_y_rejected():
    assert_message(lambda: promotions.buy_x_get_y_free(cart_mod.Cart(), "a", 1, 0), "x and y must be >= 1", "y=0")
    assert_message(lambda: promotions.buy_x_get_y_free(cart_mod.Cart(), "a", 1, -2), "x and y must be >= 1", "y=-2")


check("bogo y=0 and negative y rejected", bogo_invalid_y_rejected)


# apply_promotions.
def exclusivity_enforced():
    assert_message(
        lambda: promotions.apply_promotions(cart_mod.Cart(), [("percent", 10), ("percent", 20)]),
        "percentage promotions are exclusive",
        "two percent promos",
    )

check("two percentage promotions rejected", exclusivity_enforced)


def discount_capped_at_subtotal():
    cart = cart_mod.Cart()
    cart.add_item("a", "Apple", 100, 2)
    result = promotions.apply_promotions(cart, [("percent", 100), ("bogo", "a", 1, 1)])
    assert_equal(result.total_discount_cents, 200, "capped total")

check("discount capped at subtotal", discount_capped_at_subtotal)


def empty_promotions():
    result = promotions.apply_promotions(fresh_cart(), [])
    assert_equal(result.total_discount_cents, 0, "empty total")
    assert_equal(result.lines, [], "empty lines")

check("empty promotions list", empty_promotions)


def apply_does_not_mutate_cart():
    cart = fresh_cart()
    before = [(item.sku, item.quantity) for item in cart.items()]
    promotions.apply_promotions(cart, [("percent", 10), ("bogo", "a", 1, 1)])
    after = [(item.sku, item.quantity) for item in cart.items()]
    assert_equal(after, before, "cart lines")
    assert_equal(cart.subtotal_cents(), 400, "cart subtotal")

check("apply_promotions does not mutate the cart", apply_does_not_mutate_cart)


def promotion_error_is_value_error():
    if not issubclass(promotions.PromotionError, ValueError):
        raise AssertionError("PromotionError must subclass ValueError")

check("PromotionError subclasses ValueError", promotion_error_is_value_error)


# Receipts: exact format.
def receipt_exact_format():
    cart = cart_mod.Cart()
    cart.add_item("a", "Apple", 150, 2)
    cart.add_item("b", "Banana", 250, 1)
    text = receipt.format_receipt_with_promotions(cart, [("percent", 5), ("bogo", "a", 1, 1)])
    expected = "\n".join(
        [
            "RECEIPT",
            "Apple x2 @150c = 300c",
            "Banana x1 @250c = 250c",
            "SUBTOTAL: 550c",
            "PROMOTIONS",
            "5% OFF: -28c",
            "BOGO a (1+1): -150c",
            "TOTAL: 372c",
        ]
    )
    assert_equal(text, expected, "receipt body")

check("receipt exact format with promotions", receipt_exact_format)


def receipt_without_promotions():
    text = receipt.format_receipt_with_promotions(fresh_cart(), [])
    expected = "\n".join(
        [
            "RECEIPT",
            "Apple x1 @150c = 150c",
            "Banana x1 @250c = 250c",
            "SUBTOTAL: 400c",
            "TOTAL: 400c",
        ]
    )
    assert_equal(text, expected, "receipt body")

check("receipt omits promotion section when empty", receipt_without_promotions)


# Bundled suites must also pass (existing-behavior guard).
for suite_name in ("test_cart", "test_promotions"):
    module = load(suite_name)
    result = unittest.TextTestRunner(stream=io.StringIO()).run(
        unittest.defaultTestLoader.loadTestsFromModule(module)
    )
    total += result.testsRun
    for case, traceback in result.failures + result.errors:
        failures.append(f"{suite_name}.{case.id().split('.')[-1]}: {traceback.splitlines()[-1] if traceback else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)
