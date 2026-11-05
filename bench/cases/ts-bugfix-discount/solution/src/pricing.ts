export interface LineItem {
  /** Unit price in cents. */
  price: number;
  quantity: number;
}

/** Total in cents after a percentage discount (0-100), rounded to the nearest cent. */
export function totalWithDiscount(items: LineItem[], discountPercent: number): number {
  if (discountPercent < 0 || discountPercent > 100) {
    throw new RangeError(`discount must be between 0 and 100, got ${discountPercent}`);
  }
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(subtotal * (1 - discountPercent / 100));
}
