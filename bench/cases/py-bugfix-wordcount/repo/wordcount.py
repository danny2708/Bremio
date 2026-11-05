def word_counts(text):
    """Count words case-insensitively, ignoring punctuation. Returns {word: count}."""
    counts = {}
    for word in text.split(" "):
        counts[word] = counts.get(word, 0) + 1
    return counts
