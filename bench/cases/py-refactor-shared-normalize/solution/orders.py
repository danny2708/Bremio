from text_utils import normalize


def order_label(order_id, customer_name):
    return f"#{order_id} for {normalize(customer_name)}"
