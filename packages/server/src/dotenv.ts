/**
 * dotenv, without the line it prints about itself.
 *
 * dotenv 17 began announcing `injected env (N) from .env` on **stdout**, and
 * stdout here is the log: one JSON object per line, shipped to Log Analytics.
 * `quiet` is the supported way to silence it.
 *
 * It is a module rather than two statements in the entrypoints because an ES
 * module's imports are all evaluated before its own first statement: with
 * `config()` written in `index.ts`, every module that file imports would have
 * been evaluated first, and anything among them reading `process.env` at module
 * scope would have read it before the file was loaded. Importing this first
 * keeps the old `import 'dotenv/config'` ordering exactly.
 */
import { config } from 'dotenv';

config({ quiet: true });
