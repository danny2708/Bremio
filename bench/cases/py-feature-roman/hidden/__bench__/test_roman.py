import unittest

import roman


class RomanTest(unittest.TestCase):
    def test_known(self):
        self.assertEqual(roman.to_roman(4), "IV")
        self.assertEqual(roman.to_roman(1994), "MCMXCIV")
        self.assertEqual(roman.to_roman(3999), "MMMCMXCIX")

    def test_round_trip(self):
        for n in range(1, 4000):
            self.assertEqual(roman.from_roman(roman.to_roman(n)), n)

    def test_range(self):
        with self.assertRaises(ValueError):
            roman.to_roman(0)
        with self.assertRaises(ValueError):
            roman.to_roman(4000)


if __name__ == "__main__":
    unittest.main()
