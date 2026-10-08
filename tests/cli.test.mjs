import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { run, matches, redact } from '../src/util.mjs';
import { validateManifest } from '../src/manifest.mjs';

const cli = fileURLToPath(new URL('../bin/jevtool.mjs', import.meta.url));

test('init works from a subdirectory and never overwrites acceptance criteria', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'nested'));
  const command = [process.execPath, cli, 'init', '--task', 'Fix login'];
  assert.equal((await run(command, { cwd: join(root, 'nested') })).code, 0);
  const file = join(root, '.jevtool/acceptance.json');
  const original = await readFile(file, 'utf8');
  assert.equal(JSON.parse(original).task, 'Fix login');
  assert.equal((await run(command, { cwd: root })).code, 3);
  assert.equal(await readFile(file, 'utf8'), original);
  const result = await run([process.execPath, cli, 'verify', '--json'], { cwd: root });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).status, 'review');
});

test('invalid options and manifests have an operational error exit', async t => {
  const result = await run([process.execPath, cli, 'demo', '--judge'], { cwd: await fixture(t) });
  assert.equal(result.code, 3);
  assert.throws(() => validateManifest({ version: 1, task: 'x', criteria: [{ id: 'x', description: 'x', paths: ['../secret'] }] }), /repository-relative/);
  assert.throws(() => validateManifest({ version: 1, task: 'x', criteria: [{ id: 'x', description: 'x', tests: ['unknown'] }] }), /unknown test/);
});

test('glob semantics handle root files, nested paths and literal dots', () => {
  assert.equal(matches('root.css', '**/*.css'), true);
  assert.equal(matches('src/theme.css', '**/*.css'), true);
  assert.equal(matches('src/themeXcss', '**/*.css'), false);
  assert.equal(matches('src/nested/theme.css', 'src/*.css'), false);
});

test('redaction covers common credential and private key forms', () => {
  const result = redact('token=secret123\nAuthorization: Bearer private-token\n-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----');
  assert.equal(result.includes('secret123'), false);
  assert.equal(result.includes('private-token'), false);
  assert.equal(result.includes('\nprivate\n'), false);
});
