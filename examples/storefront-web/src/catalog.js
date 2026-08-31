const products = new Map([
  ['coffee-beans', { id: 'coffee-beans', name: 'House Coffee Beans', priceCents: 1_590 }],
  ['travel-mug', { id: 'travel-mug', name: 'Travel Mug', priceCents: 890 }],
]);

export function getProduct(productId) {
  const product = products.get(productId);
  if (!product) throw new Error(`Unknown product: ${productId}`);
  return { ...product };
}

export function listProducts() {
  return [...products.values()].map((product) => ({ ...product }));
}
