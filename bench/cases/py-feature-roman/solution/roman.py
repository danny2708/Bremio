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


_PAIRS = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]


def to_roman(n):
    """Convert 1..3999 to a Roman numeral."""
    if not isinstance(n, int) or n < 1 or n > 3999:
        raise ValueError(f"out of range: {n}")
    out = []
    for value, symbol in _PAIRS:
        while n >= value:
            out.append(symbol)
            n -= value
    return "".join(out)
