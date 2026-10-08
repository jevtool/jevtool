import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/util.mjs';

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jevtool-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/login.js'), 'export const login = value => value.length > 0;\n');
  await writeFile(join(root, '.gitignore'), '.jevtool/report*.json\n');
  for (const command of [['git', 'init', '-q'], ['git', 'add', '.'],
    ['git', '-c', 'user.name=Jevtool Test', '-c', 'user.email=test@jevtool.dev', 'commit', '-qm', 'Baseline']]) {
    const result = await run(command, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr);
  }
  await writeFile(join(root, 'src/login.js'), 'export const login = value => value.trim().length > 0;\n');
  return root;
}

export function adapter(probability = 0.96) {
  return async (_state, questions) => ({ model: 'test-fixture-not-live', usage: { input_tokens: 100 },
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: probability }])) });
}
