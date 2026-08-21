import unittest

from cart import Cart
from promotions import apply_promotions, buy_x_get_y_free, percentage_discount
from receipt import format_receipt_with_promotions


class PercentageDiscountTest(unittest.TestCase):
    def test_whole_number_percent(self):
        cart = Cart()
        cart.add_item("a", "Apple", 1000, 1)
        self.assertEqual(percentage_discount(cart, 10), 100)

    def test_percent_bound_is_allowed(self):
        cart = Cart()
        cart.add_item("a", "Apple", 250, 2)
        self.assertEqual(percentage_discount(cart, 100), 500)


class BuyXGetYFreeTest(unittest.TestCase):
    def test_exact_group(self):
        cart = Cart()
        cart.add_item("a", "Apple", 300, 3)
        self.assertEqual(buy_x_get_y_free(cart, "a", 2, 1), 300)


class ApplyPromotionsTest(unittest.TestCase):
    def test_sums_independent_discounts(self):
        cart = Cart()
        cart.add_item("a", "Apple", 1000, 3)
        result = apply_promotions(cart, [("percent", 10), ("bogo", "a", 2, 1)])
        self.assertEqual(result.total_discount_cents, 1000 + 300)

    def test_line_descriptions(self):
        cart = Cart()
        cart.add_item("a", "Apple", 1000, 3)
        result = apply_promotions(cart, [("percent", 10), ("bogo", "a", 2, 1)])
        self.assertEqual(result.lines[0].description, "10% OFF")
        self.assertEqual(result.lines[1].description, "BOGO a (2+1)")


class ReceiptTest(unittest.TestCase):
    def test_total_line_reflects_discount(self):
        cart = Cart()
        cart.add_item("a", "Apple", 1000, 1)
        text = format_receipt_with_promotions(cart, [("percent", 10)])
        self.assertIn("SUBTOTAL: 1000c", text)
        self.assertIn("10% OFF: -100c", text)
        self.assertIn("TOTAL: 900c", text)


if __name__ == "__main__":
    unittest.main()
