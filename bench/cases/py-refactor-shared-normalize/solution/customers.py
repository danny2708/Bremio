from text_utils import normalize


def customer_key(name):
    return normalize(name).lower().replace(" ", "-")
