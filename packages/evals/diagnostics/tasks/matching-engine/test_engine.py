import unittest

from engine import MatchingEngine, Order, Trade


class SubmitTest(unittest.TestCase):
    def test_single_crossing_fill_maker_price(self):
        eng = MatchingEngine()
        eng.submit(Order(1, "sell", 100, 5))
        trades = eng.submit(Order(2, "buy", 100, 3))
        self.assertEqual(trades, [Trade(2, 1, 100, 3)])
        buys, sells = eng.book()
        self.assertEqual(buys, [])
        self.assertEqual(sells, [Order(1, "sell", 100, 2)])

    def test_multi_level_fill_priority_consumes_all(self):
        eng = MatchingEngine()
        eng.submit(Order(10, "sell", 99, 2))
        eng.submit(Order(11, "sell", 98, 4))
        trades = eng.submit(Order(12, "buy", 100, 5))
        self.assertEqual(trades, [Trade(12, 11, 98, 4), Trade(12, 10, 99, 1)])
        buys, sells = eng.book()
        self.assertEqual(sells, [Order(10, "sell", 99, 1)])

    def test_partial_fill_remainder_rests_fifo(self):
        eng = MatchingEngine()
        eng.submit(Order(20, "buy", 95, 10))
        eng.submit(Order(21, "buy", 95, 2))
        trades = eng.submit(Order(22, "sell", 95, 5))
        self.assertEqual(trades, [Trade(20, 22, 95, 5)])
        buys, sells = eng.book()
        self.assertEqual(buys, [Order(20, "buy", 95, 5), Order(21, "buy", 95, 2)])
        self.assertEqual(sells, [])

    def test_buy_below_sell_does_not_cross(self):
        eng = MatchingEngine()
        eng.submit(Order(1, "sell", 100, 5))
        trades = eng.submit(Order(2, "buy", 99, 3))
        self.assertEqual(trades, [])
        buys, sells = eng.book()
        self.assertEqual(buys, [Order(2, "buy", 99, 3)])
        self.assertEqual(sells, [Order(1, "sell", 100, 5)])


class CancelTest(unittest.TestCase):
    def test_cancel_removes_and_frees_id(self):
        eng = MatchingEngine()
        eng.submit(Order(30, "buy", 100, 7))
        self.assertTrue(eng.cancel(30))
        buys, sells = eng.book()
        self.assertEqual(buys, [])
        self.assertFalse(eng.cancel(30))
        trades = eng.submit(Order(30, "buy", 90, 1))
        self.assertEqual(trades, [])


class ErrorTest(unittest.TestCase):
    def test_duplicate_live_id_raises(self):
        eng = MatchingEngine()
        eng.submit(Order(5, "buy", 100, 3))
        with self.assertRaises(ValueError):
            eng.submit(Order(5, "buy", 90, 1))

    def test_price_qty_bound(self):
        eng = MatchingEngine()
        with self.assertRaises(ValueError):
            eng.submit(Order(1, "buy", 0, 5))
        with self.assertRaises(ValueError):
            eng.submit(Order(2, "sell", 100, 0))


class StateTest(unittest.TestCase):
    def test_state_counts_resting(self):
        eng = MatchingEngine()
        eng.submit(Order(1, "sell", 100, 5))
        eng.submit(Order(2, "buy", 99, 3))
        eng.submit(Order(3, "sell", 101, 2))
        self.assertEqual(eng.state(), 3)
        eng.cancel(2)
        self.assertEqual(eng.state(), 2)
        eng.submit(Order(4, "buy", 102, 10))  # fills both sells
        self.assertEqual(eng.state(), 1)


if __name__ == "__main__":
    unittest.main()