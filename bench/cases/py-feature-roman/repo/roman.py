_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def from_roman(text):
    """Convert a Roman numeral to an int."""
    total = 0
    for i, ch in enumerate(text):
        value = _VALUES[ch]
        if i + 1 < len(text) and _VALUES[text[i + 1]] > value:
            total -= value
        else:
            total += value
    return total
