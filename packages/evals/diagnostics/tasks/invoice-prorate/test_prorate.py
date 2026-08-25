import unittest

from invoice import Invoice
from prorate import PaymentError, allocate_payment


def invoice_with(*amounts):
    invoice = Invoice()
    for index, amount in enumerate(amounts):
        invoice.add_line(f"s{index}", f"Item {index}", amount)
    return invoice


class AllocatePaymentTest(unittest.TestCase):
    def test_even_split(self):
        self.assertEqual(allocate_payment(invoice_with(100, 300), 100), [25, 75])

    def test_zero_payment(self):
        self.assertEqual(allocate_payment(invoice_with(100, 300), 0), [0, 0])

    def test_single_line_takes_all(self):
        self.assertEqual(allocate_payment(invoice_with(250), 200), [200])

    def test_negative_payment_raises(self):
        with self.assertRaises(PaymentError):
            allocate_payment(invoice_with(100, 300), -1)


if __name__ == "__main__":
    unittest.main()
