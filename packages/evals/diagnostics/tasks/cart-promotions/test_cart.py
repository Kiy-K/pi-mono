import unittest

from cart import Cart, CartError


class CartTest(unittest.TestCase):
    def test_subtotal_sums_lines(self):
        cart = Cart()
        cart.add_item("a", "Apple", 100, 2)
        cart.add_item("b", "Banana", 50, 3)
        self.assertEqual(cart.subtotal_cents(), 350)

    def test_add_merges_same_sku(self):
        cart = Cart()
        cart.add_item("a", "Apple", 100, 1)
        cart.add_item("a", "Apple", 100, 2)
        self.assertEqual(len(cart.items()), 1)
        self.assertEqual(cart.items()[0].quantity, 3)

    def test_remove_unknown_sku_raises(self):
        cart = Cart()
        with self.assertRaises(CartError):
            cart.remove_item("missing")


if __name__ == "__main__":
    unittest.main()
