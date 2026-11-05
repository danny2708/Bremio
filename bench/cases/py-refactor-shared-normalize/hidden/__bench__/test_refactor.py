import unittest

import customers
import orders
import text_utils


class RefactorTest(unittest.TestCase):
    def test_single_definition(self):
        self.assertIs(orders.normalize, text_utils.normalize)
        self.assertIs(customers.normalize, text_utils.normalize)

    def test_behaviour(self):
        self.assertEqual(text_utils.normalize("  ada   lovelace "), "Ada Lovelace")
        self.assertEqual(orders.order_label(7, "  ada   lovelace "), "#7 for Ada Lovelace")
        self.assertEqual(customers.customer_key("grace  HOPPER"), "grace-hopper")


if __name__ == "__main__":
    unittest.main()
