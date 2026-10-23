import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSuite, evaluateSuite, suggestThreshold, listExamples, loadSuite, evalExitCode } from '../src/eval.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/jevtool.mjs', import.meta.url).pathname;

const suite = {
  name: 'fixture',
  questions: {
    team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money', support: 'Help' } },
    urgent: { type: 'noul', instructions: 'Is it urgent?' },
    size: { type: 'score', instructions: 'How big?', criteria: ['small', 'medium', 'large'] },
  },
  cases: [
    { id: 'a', state: { text: 'refund now' }, expect: { team: 'billing', urgent: true, size: 1 }, tags: ['en'] },
    { id: 'b', state: { text: 'how do I' }, expect: { team: 'support', urgent: false, size: 0 }, tags: ['en'] },
    { id: 'c', state: { text: '退款' }, expect: { team: ['billing', 'support'], urgent: null }, tags: ['zh'] },
  ],
};

// Fake Jev: answers depend on the model name so version comparisons can be tested.
const judgeFor = model => async (state, questions) => {
  const billing = /refund|退款/.test(state.text);
  const firstOption = Object.keys(questions.team.criteria)[0];
  const choice = model === 'flaky' ? firstOption : billing ? 'billing' : 'support';
  return {
    model: `${model}-resolved`, usage: { input_tokens: 100 },
    answers: {
      team: { type: 'choice', choice, confidence: billing ? 0.9 : 0.6, probabilities: { billing: billing ? 0.95 : 0.2, support: billing ? 0.05 : 0.8 } },
      urgent: { type: 'noul', noul: billing ? 0.92 : 0.3 },
      size: { type: 'score', score: billing ? 1.1 : 0.2, confidence: 0.7, probabilities: billing ? { 0: 0.05, 1: 0.8, 2: 0.15 } : { 0: 0.85, 1: 0.1, 2: 0.05 } },
    },
  };
};

test('valid suites pass and malformed suites explain the problem', () => {
  validateSuite(suite);
  assert.throws(() => validateSuite({ ...suite, questions: {} }), /at least one question/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ state: {}, expect: { team: 'sales' } }] }), /not in its criteria/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ state: {}, expect: { size: 3 } }] }), /level index 0–2/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ state: {}, expect: { urgent: 'yes' } }] }), /expect true or false/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ id: 1, state: {} }, { id: 1, state: {} }] }), /duplicate case id/);
  assert.throws(() => validateSuite({ ...suite, questions: { s: { type: 'score', instructions: 'x', criteria: { 0: 'a' } } } }), /ordered array/);
});

test('reports accuracy per question, per tag, misses and skips unlabeled answers', async () => {
  const report = await evaluateSuite({ suite, judgeFor, models: ['m1'] });
  const run = report.runs[0];
  assert.equal(report.status, 'passed');
  assert.equal(run.questions.team.accuracy, 1);
  assert.equal(run.questions.urgent.scored, 2);
  assert.equal(run.questions.size.accuracy, 1);
  assert.deepEqual(run.questions.team.tags, { en: { n: 2, correct: 2 }, zh: { n: 1, correct: 1 } });
  assert.equal(run.avgInputTokens, 100);
  assert.equal(run.resolvedModels[0], 'm1-resolved');
});

test('comparing models lists the answers that flipped', async () => {
  const report = await evaluateSuite({ suite, judgeFor, models: ['m1', 'flaky'] });
  assert.deepEqual(report.comparisons[0].flips.team.map(f => f.id), ['b']);
  assert.equal(report.comparisons[0].flips.urgent.length, 0);
});

test('order check catches choices that follow option position', async () => {
  const report = await evaluateSuite({ suite, judgeFor, models: ['flaky'], orderCheck: true });
  assert.deepEqual(report.runs[0].questions.team.orderFlips.sort(), ['a', 'b', 'c']);
});

test('min accuracy fails the run and request errors require review', async () => {
  const failed = await evaluateSuite({ suite, judgeFor, models: ['flaky'], minAccuracy: 0.9 });
  assert.equal(failed.status, 'failed');
  assert.equal(evalExitCode(failed), 1);
  let calls = 0;
  const partial = await evaluateSuite({ suite, models: ['m1'], judgeFor: () => async (...args) => {
    if (calls++ === 0) throw new Error('Jev returned HTTP 500.');
    return judgeFor('m1')(...args);
  } });
  assert.equal(partial.status, 'review');
  assert.equal(evalExitCode(partial), 2);
  const down = await evaluateSuite({ suite, models: ['m1'], judgeFor: () => async () => { throw new Error('down'); } });
  assert.equal(evalExitCode(down), 3);
});

test('threshold suggestion finds the smallest cutoff that meets the target', () => {
  const rows = [
    { certainty: 0.55, correct: false }, { certainty: 0.7, correct: true },
    { certainty: 0.9, correct: true }, { certainty: 0.95, correct: true },
  ];
  assert.deepEqual(suggestThreshold(rows, 0.95), { threshold: 0.7, coverage: 0.75, accuracy: 1, automated: 3 });
  assert.equal(suggestThreshold([{ certainty: 0.9, correct: false }], 0.95), null);
});

test('every bundled example suite is valid', async () => {
  const examples = await listExamples();
  assert.ok(examples.length >= 10);
  for (const e of examples) await loadSuite(`example:${e.name}`);
  await assert.rejects(loadSuite('example:nope'), /Unknown example/);
});

test('cli lists and saves examples without an API key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jevtool-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, TYPESAFE_API_KEY: '', JEV_API_KEY: '' };
  const list = await exec('node', [BIN, 'eval', '--examples'], { env });
  assert.match(list.stdout, /example:support-triage/);
  await exec('node', [BIN, 'eval', 'example:inbox-triage', '--save', 'mine.json'], { cwd: dir, env });
  assert.equal(JSON.parse(await readFile(join(dir, 'mine.json'), 'utf8')).name, 'inbox-triage');
  await assert.rejects(exec('node', [BIN, 'eval', 'example:inbox-triage'], { cwd: dir, env }), error => error.code === 3 && /TYPESAFE_API_KEY/.test(error.stderr));
});

test('reported per-call cost wins over the list-price estimate; unknown models get no estimate', async () => {
  const withCost = model => async (state, questions) => {
    const r = await judgeFor('m1')(state, questions);
    return model === 'priced' ? { ...r, usage: { input_tokens: 100, cost: 0.00002 } } : r;
  };
  const report = await evaluateSuite({ suite, models: ['priced', 'other/unpriced', 'typesafe/jev-1.13'], judgeFor: withCost });
  const [priced, unpriced, jev] = report.runs;
  assert.deepEqual([priced.costSource, priced.estCostPer1kCalls], ['reported', 0.02]);
  assert.deepEqual([unpriced.costSource, unpriced.estCostPer1kCalls], [null, null]);
  assert.equal(jev.costSource, 'jev-list-price');
});
