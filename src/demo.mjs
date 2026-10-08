import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './util.mjs';
import { validateManifest } from './manifest.mjs';
import { verify } from './verify.mjs';

export async function demo(judge) {
  const root = await mkdtemp(join(tmpdir(), 'jevtool-demo-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'src/login.cjs'), 'exports.login = password => password.length > 0;\n');
    await writeFile(join(root, 'src/style.css'), 'body { color: black; }\n');
    await writeFile(join(root, 'test/login.cjs'), "const { login } = require('../src/login.cjs');\nrequire('node:assert/strict').equal(login('   '), false);\n");
    for (const command of [['git', 'init', '-q'], ['git', 'add', '.'],
      ['git', '-c', 'user.name=Jevtool Demo', '-c', 'user.email=demo@jevtool.dev', 'commit', '-qm', 'Demo baseline']]) {
      const result = await run(command, { cwd: root });
      if (result.code !== 0) throw new Error('Cannot create the temporary demo repository.');
    }
    // Deliberately incomplete delivery: unrelated CSS change, failing test, missing regression file.
    await writeFile(join(root, 'src/login.cjs'), 'exports.login = password => Boolean(password);\n');
    await writeFile(join(root, 'src/style.css'), 'body { color: pink; }\n');
    const manifest = validateManifest({ version: 1, task: 'Reject whitespace-only passwords, add a regression test, keep styles unchanged.',
      criteria: [
        { id: 'login', description: 'Whitespace-only passwords are rejected.', paths: ['src/login.cjs'], tests: ['login'], kind: 'judgment' },
        { id: 'regression', description: 'Add a regression test file.', paths: ['test/regression.cjs'], kind: 'changed' },
        { id: 'styles', description: 'Keep CSS files unchanged.', paths: ['**/*.css'], kind: 'unchanged' },
      ], tests: [{ id: 'login', command: [process.execPath, '--test', 'test/login.cjs'] }] });
    return { ...await verify({ root, manifest, runTests: true, judge }), demo: true };
  } finally { await rm(root, { recursive: true, force: true }); }
}
