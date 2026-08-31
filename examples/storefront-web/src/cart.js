import { getProduct } from './catalog.js';

export function createCart() {
  return { items: [] };
}

export function addItem(cart, productId, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError('quantity must be a positive integer');
  }

  const product = getProduct(productId);
  const existing = cart.items.find((item) => item.productId === productId);
  const items = existing
    ? cart.items.map((item) =>
        item.productId === productId ? { ...item, quantity: item.quantity + quantity } : item,
      )
    : [...cart.items, { productId, unitPriceCents: product.priceCents, quantity }];

  return { ...cart, items };
}

export function summarizeCart(cart) {
  return cart.items.reduce(
    (summary, item) => ({
      itemCount: summary.itemCount + item.quantity,
      subtotalCents: summary.subtotalCents + item.quantity * item.unitPriceCents,
    }),
    { itemCount: 0, subtotalCents: 0 },
  );
}
