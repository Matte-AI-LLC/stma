/**
 * A confirmation belongs to the form, because that is where the page script
 * reads it.
 *
 * `ui/client.ts` asks `form[data-confirm]` and nothing else. Eight
 * confirmations (four on the organization page, the project and thread cancel
 * buttons, and both repository binding actions) had been written on the
 * submit `<button>` instead, so the browser submitted them with no question at
 * all: deactivating an organization member, resetting an identity link,
 * disconnecting a provider and cancelling an assignment each went through on
 * one click. Found on 2026-10-22 while adding the authenticator switch's own
 * confirmation. This scans every page source, the private layer's included
 * where it exists, so the next one is a red suite rather than a silent click.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

const sources = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? sources(full) : /\.tsx$/.test(name) ? [full] : [];
      })
    : [];

/** The element a `data-confirm=` sits on: the nearest opening tag before it. */
function ownerTag(text: string, at: number): string | undefined {
  let tag: string | undefined;
  for (const match of text.slice(0, at).matchAll(/<([a-zA-Z][\w.]*)\b/g)) tag = match[1];
  return tag;
}

it('reads a confirmation from a form, which is where the page script looks', () => {
  expect(readFileSync(path.join(root, 'packages/server/src/ui/client.ts'), 'utf8')).toContain(
    "querySelectorAll('form[data-confirm]')",
  );
  const misplaced: string[] = [];
  let seen = 0;
  for (const file of [
    ...sources(path.join(root, 'packages/server/src')),
    // The public tree has no ee/, the same as the one-door scan.
    ...sources(path.join(root, 'ee/src')),
  ]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/data-confirm=/g)) {
      seen++;
      const tag = ownerTag(text, match.index!);
      if (tag !== 'form') {
        const line = text.slice(0, match.index).split('\n').length;
        misplaced.push(`${path.relative(root, file).split(path.sep).join('/')}:${line} <${tag}>`);
      }
    }
  }
  expect(seen).toBeGreaterThan(10);
  expect(misplaced).toEqual([]);
});
