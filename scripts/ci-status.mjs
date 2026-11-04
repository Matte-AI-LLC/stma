import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The public source lacks the exporter and both optional private directories. */
export function exportRequired({ exporter, ee, acceptance }) {
  if (!exporter && (ee || acceptance)) throw new Error('The source layout requires the public exporter.');
  return exporter;
}

/** Fail closed on missing, failed, cancelled, or unexpectedly skipped jobs. */
export function aggregatePassed({ layout, core, publicSource, required }) {
  if (layout !== 'success' || core !== 'success') return false;
  if (required === 'true') return publicSource === 'success';
  if (required === 'false') return publicSource === 'skipped';
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'layout') {
      const required = exportRequired({ exporter: existsSync('scripts/public-tree.mjs'), ee: existsSync('ee'), acceptance: existsSync('acceptance') });
      if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output destination.');
      appendFileSync(process.env.GITHUB_OUTPUT, `export_required=${required}\n`);
    } else if (process.argv[2] === 'aggregate') {
      if (!aggregatePassed({ layout: process.env.LAYOUT_RESULT, core: process.env.CORE_RESULT, publicSource: process.env.PUBLIC_RESULT, required: process.env.EXPORT_REQUIRED })) {
        throw new Error('Required CI results are incomplete or unsuccessful.');
      }
    } else throw new Error('Unknown CI status operation.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI status failed.');
    process.exitCode = 1;
  }
}
