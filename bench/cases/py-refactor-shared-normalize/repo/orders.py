def normalize(name):
    """Collapse whitespace and title-case a name."""
    return " ".join(name.split()).title()


def order_label(order_id, customer_name):
    return f"#{order_id} for {normalize(customer_name)}"
