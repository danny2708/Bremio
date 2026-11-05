export interface LineItem {
  /** Unit price in cents. */
  price: number;
  quantity: number;
}

/** Total in cents after a percentage discount (0-100), rounded to the nearest cent. */
export function totalWithDiscount(items: LineItem[], discountPercent: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return Math.round(subtotal * (1 - discountPercent));
}
