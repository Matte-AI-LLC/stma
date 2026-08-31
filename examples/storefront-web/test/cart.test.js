import assert from 'node:assert/strict';
import test from 'node:test';

import { addItem, createCart, summarizeCart } from '../src/cart.js';
import { listProducts } from '../src/catalog.js';

test('adds different products and calculates a deterministic subtotal', () => {
  const empty = createCart();
  const withCoffee = addItem(empty, 'coffee-beans', 2);
  const cart = addItem(withCoffee, 'travel-mug');

  assert.deepEqual(summarizeCart(cart), { itemCount: 3, subtotalCents: 4_070 });
  assert.deepEqual(empty, { items: [] }, 'cart updates stay immutable');
});

test('merges repeated product lines', () => {
  const cart = addItem(addItem(createCart(), 'travel-mug'), 'travel-mug', 2);

  assert.deepEqual(cart.items, [
    { productId: 'travel-mug', unitPriceCents: 890, quantity: 3 },
  ]);
});

test('rejects invalid quantities and unknown products', () => {
  assert.throws(() => addItem(createCart(), 'travel-mug', 0), /positive integer/);
  assert.throws(() => addItem(createCart(), 'missing'), /Unknown product/);
});

test('catalog callers cannot mutate the source records', () => {
  const firstRead = listProducts();
  firstRead[0].priceCents = 1;

  assert.equal(listProducts()[0].priceCents, 1_590);
});
