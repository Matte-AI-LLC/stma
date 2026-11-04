import { expect, it } from 'vitest';
import { text } from '../src/mcp/shared';

it('serializes structured MCP replies compactly without changing their values', () => {
  const payload = { text: 'Türkçe and newline\n', rows: [{ id: 1, ok: true }, { id: 2, note: null }] };
  const result = text(payload).content[0]!.text;
  expect(JSON.parse(result)).toEqual(payload);
  expect(result).toBe(JSON.stringify(payload));
  expect(Buffer.byteLength(result)).toBeLessThan(Buffer.byteLength(JSON.stringify(payload, null, 2)));
  expect(text('literal').content[0]!.text).toBe('literal');
});
