import { expect, it } from 'vitest';
import { Head } from '../src/ui/Layout';

it('renders the console without a third-party blocking stylesheet', () => {
  const html = Head({ title: 'Test' }).toString();
  expect(html).toContain('rel="stylesheet" href="/style.');
  expect(html).not.toContain('fonts.googleapis.com');
  expect(html).not.toContain('fonts.gstatic.com');
});
