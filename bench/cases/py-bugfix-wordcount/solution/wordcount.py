import re

_WORD = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)*")


def word_counts(text):
    """Count words case-insensitively, ignoring punctuation. Returns {word: count}."""
    counts = {}
    for word in _WORD.findall(text.lower()):
        counts[word] = counts.get(word, 0) + 1
    return counts
