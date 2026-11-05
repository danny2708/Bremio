import unittest

from wordcount import word_counts


class WordCountTest(unittest.TestCase):
    def test_case_and_punctuation(self):
        self.assertEqual(word_counts("Hello hello, world!"), {"hello": 2, "world": 1})

    def test_whitespace(self):
        self.assertEqual(word_counts("a\tb\n\n  b"), {"a": 1, "b": 2})

    def test_apostrophe(self):
        self.assertEqual(word_counts("Don't stop"), {"don't": 1, "stop": 1})

    def test_empty(self):
        self.assertEqual(word_counts(""), {})


if __name__ == "__main__":
    unittest.main()
