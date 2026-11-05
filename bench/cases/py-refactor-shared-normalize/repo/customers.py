def normalize(name):
    """Collapse whitespace and title-case a name."""
    return " ".join(name.split()).title()


def customer_key(name):
    return normalize(name).lower().replace(" ", "-")
