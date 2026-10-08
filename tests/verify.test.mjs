import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, adapter } from './helpers.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { verify, verifyExitCode } from '../src/verify.mjs';
import { demo } from '../src/demo.mjs';

function manifest(overrides = {}) {
  return validateManifest({ version: 1, task: 'Reject blank passwords',
    criteria: [{ id: 'login', description: 'Reject whitespace-only passwords.', paths: ['src/login.js'], tests: ['unit'] }],
    tests: [{ id: 'unit', command: [process.execPath, '-e', 'process.exit(0)'] }], ...overrides });
}

test('no commands or judgments run without explicit options', async t => {
  const root = await fixture(t);
  const report = await verify({ root, manifest: manifest() });
  assert.equal(report.tests[0].status, 'not_run');
  assert.equal(report.status, 'review');
  assert.equal(verifyExitCode(report), 2);
  assert.equal(report.judgment.model, null);
});

test('linked tests and valid judgment produce evidence support', async t => {
  const report = await verify({ root: await fixture(t), manifest: manifest(), runTests: true, judge: adapter() });
  assert.equal(report.status, 'supported');
  assert.equal(report.tests[0].exitCode, 0);
  assert.equal(report.checks[0].files[0].path, 'src/login.js');
  assert.equal(verifyExitCode(report), 0);
});

test('failing real test takes precedence over model approval', async t => {
  const m = manifest({ tests: [{ id: 'unit', command: [process.execPath, '-e', 'process.exit(7)'] }] });
  let called = false;
  const report = await verify({ root: await fixture(t), manifest: m, runTests: true,
    judge: async () => { called = true; return adapter()({}, {}); } });
  assert.equal(report.status, 'failed');
  assert.equal(report.tests[0].exitCode, 7);
  assert.equal(called, false);
});

test('provider errors and missing answers remain reviewable', async t => {
  const root = await fixture(t);
  for (const judge of [async () => { throw new Error('HTTP 529'); }, async () => ({ model: 'fixture', answers: {} })]) {
    const report = await verify({ root, manifest: manifest(), runTests: true, judge });
    assert.equal(report.status, 'review');
    assert.equal(report.checks[0].reason, 'judgment_unavailable');
  }
});

test('uncertain probability is not an approval', async t => {
  const report = await verify({ root: await fixture(t), manifest: manifest(), runTests: true, judge: adapter(0.6) });
  assert.equal(report.status, 'review');
});

test('unchanged checks catch untracked protected files', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/new.css'), 'body { color: pink; }');
  const m = manifest({ tests: [], criteria: [{ id: 'styles', kind: 'unchanged', paths: ['**/*.css'], description: 'Keep styles unchanged.' }] });
  assert.equal((await verify({ root, manifest: m })).status, 'failed');
});

test('sensitive paths and symlinks cannot receive semantic approval', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'TOKEN=do-not-send');
  await symlink('/etc/hosts', join(root, 'external.txt'));
  const m = manifest({ tests: [], criteria: [
    { id: 'secret', paths: ['.env'], description: 'Inspect secret file' },
    { id: 'link', paths: ['external.txt'], description: 'Inspect linked file' },
  ] });
  let called = false;
  const report = await verify({ root, manifest: m, judge: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(report.status, 'review');
  assert.equal(JSON.stringify(report).includes('do-not-send'), false);
});

test('changes during the model request invalidate a supported aggregate', async t => {
  const root = await fixture(t);
  const report = await verify({ root, manifest: manifest(), runTests: true,
    judge: async (state, questions) => {
      await writeFile(join(root, 'src/login.js'), 'export const login = () => true;\n');
      return adapter()(state, questions);
    } });
  assert.equal(report.status, 'review');
  assert.ok(report.warnings.includes('working_tree_changed_during_judgment'));
});

test('test timeouts fail instead of passing on partial output', async t => {
  const m = manifest({ tests: [{ id: 'unit', timeoutMs: 100, command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'] }] });
  const report = await verify({ root: await fixture(t), manifest: m, runTests: true });
  assert.equal(report.status, 'failed');
  assert.equal(report.tests[0].timedOut, true);
});

test('deterministic checks work offline and shell metacharacters are literal argv', async t => {
  const m = manifest({ criteria: [{ id: 'test', kind: 'tests', description: 'Run a literal argv test', tests: ['unit'] }],
    tests: [{ id: 'unit', command: [process.execPath, '-e', "require('node:assert/strict').equal(process.argv[1], '; exit 9')", '; exit 9'] }] });
  assert.equal((await verify({ root: await fixture(t), manifest: m, runTests: true })).status, 'supported');
});

test('demo executes a real failing test and finds missing regression and CSS drift', async () => {
  const report = await demo();
  assert.equal(report.demo, true);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.checks.map(c => c.reason), ['linked_test_failed', 'expected_changes_missing', 'protected_paths_changed']);
});
