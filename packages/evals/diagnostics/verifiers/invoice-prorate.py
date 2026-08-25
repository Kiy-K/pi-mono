#!/usr/bin/env python3
"""External verifier for the invoice-prorate task: enforces every SPEC.md rule,
including edge cases the bundled tests do not cover."""
import importlib.util
import io
import json
import pathlib
import sys
import traceback
import unittest

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root))


def load(name):
    spec = importlib.util.spec_from_file_location(name, root / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prorate = load("prorate")
invoice_mod = load("invoice")

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
    except prorate.PaymentError as error:
        if str(error) != expected:
            raise AssertionError(f"{label}: expected message {expected!r}, got {str(error)!r}")
        return
    raise AssertionError(f"{label}: PaymentError not raised")


def invoice_with(*amounts):
    invoice = invoice_mod.Invoice()
    for index, amount in enumerate(amounts):
        invoice.add_line(f"s{index}", f"Item {index}", amount)
    return invoice


# Exact proportional shares when the payment divides evenly.
def clean_proportional_split():
    assert_equal(prorate.allocate_payment(invoice_with(100, 300), 100), [25, 75], "100 of 400")
    assert_equal(prorate.allocate_payment(invoice_with(300, 100), 400), [300, 100], "full payment")

check("clean proportional split", clean_proportional_split)


# SPEC step 3: leftover cents go to the largest fractional remainder.
def leftover_to_largest_fraction():
    # 202 over three 100c lines: leftover 1 cent, equal fracs -> line 0.
    assert_equal(prorate.allocate_payment(invoice_with(100, 100, 100), 202), [68, 67, 67], "leftover -> first line")
    assert_equal(prorate.allocate_payment(invoice_with(300, 100), 101), [76, 25], "101 of 300+100")
    # Reversed insertion order must flip the result.
    assert_equal(prorate.allocate_payment(invoice_with(100, 300), 101), [25, 76], "101 of 100+300")

check("leftover cents go to largest fractional remainder", leftover_to_largest_fraction)


# SPEC step 3: fractional-remainder ties break by insertion order.
def remainder_ties_break_by_line_order():
    # 101 over three 100c lines: shares 33.67 each, leftover 2 -> lines 0 and 1.
    assert_equal(prorate.allocate_payment(invoice_with(100, 100, 100), 101), [34, 34, 33], "ties -> earliest lines")
    # 1 cent over three 100c lines: all fracs equal, tie -> line 0.
    assert_equal(prorate.allocate_payment(invoice_with(100, 100, 100), 1), [1, 0, 0], "tie -> first line")

check("remainder ties break by line order", remainder_ties_break_by_line_order)


# SPEC step 4: conservation on messy, remainder-heavy cases.
def payment_conserved_exactly():
    cases = [
        (invoice_with(100, 100, 100), 1),
        (invoice_with(100, 100, 100), 299),
        (invoice_with(333, 1, 333, 1), 500),
        (invoice_with(7, 11, 13), 31),
        (invoice_with(99991, 3, 2), 99990),
    ]
    for invoice, payment in cases:
        allocation = prorate.allocate_payment(invoice, payment)
        assert_equal(sum(allocation), payment, f"sum for payment {payment}")
        assert_equal(len(allocation), len(invoice.lines()), f"length for payment {payment}")
        if any(cent < 0 for cent in allocation):
            raise AssertionError(f"negative allocation for payment {payment}")

check("payment conserved exactly on remainder-heavy cases", payment_conserved_exactly)


def zero_payment_allocates_zeros():
    assert_equal(prorate.allocate_payment(invoice_with(100, 300), 0), [0, 0], "zero payment")

check("zero payment allocates zeros", zero_payment_allocates_zeros)


def negative_payment_rejected():
    assert_message(lambda: prorate.allocate_payment(invoice_with(100, 300), -1), "payment out of range", "payment -1")

check("negative payment rejected", negative_payment_rejected)


def payment_above_total_rejected():
    assert_message(lambda: prorate.allocate_payment(invoice_with(100, 300), 401), "payment out of range", "payment 401 of 400")

check("payment above total rejected", payment_above_total_rejected)


def non_integer_payment_rejected():
    """SPEC: payment must be int; floats and bools are rejected."""
    assert_message(lambda: prorate.allocate_payment(invoice_with(100, 300), 100.0), "payment must be an integer number of cents", "float 100.0")
    assert_message(lambda: prorate.allocate_payment(invoice_with(100, 300), True), "payment must be an integer number of cents", "bool True")
    assert_message(lambda: prorate.allocate_payment(invoice_with(100, 300), "100"), "payment must be an integer number of cents", "str '100'")

check("non-integer payment rejected with message", non_integer_payment_rejected)


def empty_invoice_edge():
    assert_equal(prorate.allocate_payment(invoice_mod.Invoice(), 0), [], "empty invoice, zero payment")
    assert_message(lambda: prorate.allocate_payment(invoice_mod.Invoice(), 10), "payment out of range", "empty invoice, payment 10")

check("empty invoice accepts only zero payment", empty_invoice_edge)


def payment_error_is_value_error():
    if not issubclass(prorate.PaymentError, ValueError):
        raise AssertionError("PaymentError must subclass ValueError")

check("PaymentError subclasses ValueError", payment_error_is_value_error)


def allocation_does_not_mutate_invoice():
    invoice = invoice_with(100, 300)
    before = [(line.sku, line.amount_cents) for line in invoice.lines()]
    prorate.allocate_payment(invoice, 101)
    after = [(line.sku, line.amount_cents) for line in invoice.lines()]
    assert_equal(after, before, "invoice lines unchanged")

check("allocation does not mutate the invoice", allocation_does_not_mutate_invoice)


# Bundled suite must also pass (existing-behavior guard).
module = load("test_prorate")
result = unittest.TextTestRunner(stream=io.StringIO()).run(
    unittest.defaultTestLoader.loadTestsFromModule(module)
)
total += result.testsRun
for case, tb in list(result.failures) + list(result.errors):
    failures.append(f"test_prorate.{case.id().split('.')[-1]}: {tb.splitlines()[-1] if tb else 'failed'}")

print(json.dumps({"passed": not failures, "tests": total, "failures": failures[:12]}))
sys.exit(0 if not failures else 1)
