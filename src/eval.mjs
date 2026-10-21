import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './util.mjs';
import { validateSuite } from './eval-core.mjs';

export * from './eval-core.mjs';
export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'suites');

export async function listExamples() {
  const files = (await readdir(EXAMPLES_DIR)).filter(f => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) {
    const suite = JSON.parse((await readBounded(join(EXAMPLES_DIR, f))).toString('utf8'));
    out.push({ name: basename(f, '.json'), title: suite.name, description: suite.description ?? '', cases: suite.cases.length });
  }
  return out;
}

export async function loadSuite(ref) {
  const path = ref.startsWith('example:') ? join(EXAMPLES_DIR, `${ref.slice(8).replace(/[^\w-]/g, '')}.json`) : ref;
  let suite;
  try { suite = JSON.parse((await readBounded(path)).toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(ref.startsWith('example:') ? `Unknown example ${ref}. Run jevtool eval --examples to list them.` : `Suite file not found: ${path}`);
    if (error instanceof SyntaxError) throw new Error(`Suite is not valid JSON: ${path}`);
    throw error;
  }
  validateSuite(suite);
  return { suite, path };
}

