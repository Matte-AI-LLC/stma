import { createHash } from 'node:crypto';

/** SHA-1 of the git blob object ("blob <bytes>\0<content>") — same output as `git hash-object`. */
export function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}
