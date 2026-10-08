import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readBounded } from './util.mjs';

function assert(condition, message) { if (!condition) throw new Error(`Invalid acceptance file: ${message}`); }
function strings(value) { return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0); }

export function validateManifest(m) {
  assert(m && m.version === 1, 'version must be 1');
  assert(typeof m.task === 'string' && m.task.trim() && m.task.length <= 4000, 'task is required (max 4000 characters)');
  assert(m.base === undefined || (typeof m.base === 'string' && m.base.length > 0 && !m.base.startsWith('-')), 'base must be a Git revision');
  assert(Array.isArray(m.criteria) && m.criteria.length > 0 && m.criteria.length <= 30, 'provide 1–30 criteria');
  assert(m.tests === undefined || Array.isArray(m.tests), 'tests must be an array');
  const tests = m.tests ?? [];
  assert(tests.length <= 20, 'at most 20 test commands');
  const testIds = new Set();
  for (const test of tests) {
    assert(test && /^[a-zA-Z0-9_-]{1,64}$/.test(test.id) && !testIds.has(test.id), 'test ids must be unique');
    testIds.add(test.id);
    assert(strings(test.command) && test.command.length > 0 && test.command.length <= 64, `${test.id}: command must be an argv array`);
    assert(test.timeoutMs === undefined || (Number.isInteger(test.timeoutMs) && test.timeoutMs >= 100 && test.timeoutMs <= 300_000), `${test.id}: timeoutMs must be 100–300000`);
  }
  const ids = new Set();
  for (const c of m.criteria) {
    assert(c && /^[a-zA-Z0-9_-]{1,64}$/.test(c.id) && !ids.has(c.id), 'criterion ids must be unique');
    ids.add(c.id);
    assert(typeof c.description === 'string' && c.description.trim() && c.description.length <= 2000, `${c.id}: description is required`);
    assert(['judgment', 'changed', 'unchanged', 'tests'].includes(c.kind ?? 'judgment'), `${c.id}: unsupported kind`);
    if (c.paths !== undefined) {
      assert(strings(c.paths) && c.paths.length > 0 && c.paths.length <= 30, `${c.id}: paths must be a nonempty array`);
      assert(c.paths.every(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('\0')), `${c.id}: paths must be repository-relative globs`);
    }
    if (['changed', 'unchanged'].includes(c.kind)) assert(c.paths?.length, `${c.id}: paths required`);
    if (c.tests !== undefined) assert(strings(c.tests) && c.tests.every(id => testIds.has(id)), `${c.id}: unknown test id`);
    if (c.kind === 'tests') assert(c.tests?.length, `${c.id}: reference at least one test`);
  }
  return { ...m, base: m.base ?? 'HEAD', tests, criteria: m.criteria.map(c => ({ ...c, kind: c.kind ?? 'judgment', tests: c.tests ?? [] })) };
}

export async function loadManifest(path) {
  let parsed;
  try { parsed = JSON.parse((await readBounded(path, 64 * 1024)).toString('utf8')); }
  catch (error) { throw new Error(`Cannot read acceptance file ${path}: ${error.message}`); }
  return validateManifest(parsed);
}

export async function initManifest(root, task = 'Describe the change you want delivered.') {
  let testCommand;
  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (typeof pkg.scripts?.test === 'string') testCommand = ['npm', 'test'];
  } catch { /* A test command can be added later. */ }
  const m = {
    version: 1, task, base: 'HEAD',
    criteria: [{ id: 'implementation', kind: 'judgment', description: 'The code changes address the task.', paths: ['**'], ...(testCommand ? { tests: ['project-tests'] } : {}) }],
    tests: testCommand ? [{ id: 'project-tests', command: testCommand, timeoutMs: 60_000 }] : [],
  };
  const directory = resolve(root, '.jevtool');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'acceptance.json');
  await writeFile(path, JSON.stringify(m, null, 2) + '\n', { flag: 'wx' });
  try { await writeFile(resolve(directory, '.gitignore'), 'report*.json\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return path;
}
