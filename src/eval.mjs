import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './util.mjs';

// List price per input token (USD); output tokens are free. Used only for estimates.
export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6;
export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'suites');
const TYPES = ['noul', 'choice', 'score'];
const MAX_CASES = 1000;

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

export function validateSuite(suite) {
  const fail = message => { throw new Error(`Invalid suite: ${message}`); };
  if (!suite || typeof suite !== 'object') fail('expected a JSON object.');
  if (!suite.questions || typeof suite.questions !== 'object' || !Object.keys(suite.questions).length) fail('"questions" must define at least one question.');
  for (const [id, q] of Object.entries(suite.questions)) {
    if (!TYPES.includes(q?.type)) fail(`question "${id}" must have type noul, choice or score.`);
    if (!q.instructions) fail(`question "${id}" needs instructions.`);
    if (q.type === 'choice' && (!q.criteria || Array.isArray(q.criteria) || typeof q.criteria !== 'object')) fail(`choice "${id}" needs criteria as an object of option: description.`);
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2)) fail(`score "${id}" needs criteria as an ordered array of at least two levels.`);
  }
  if (!Array.isArray(suite.cases) || !suite.cases.length) fail('"cases" must be a non-empty array.');
  if (suite.cases.length > MAX_CASES) fail(`at most ${MAX_CASES} cases per suite.`);
  const ids = new Set();
  suite.cases.forEach((c, i) => {
    const where = `case ${c?.id ?? i + 1}`;
    if (c?.state === undefined) fail(`${where} needs a "state".`);
    if (c.id !== undefined) { if (ids.has(String(c.id))) fail(`duplicate case id ${c.id}.`); ids.add(String(c.id)); }
    for (const [qid, expected] of Object.entries(c.expect ?? {})) {
      const q = suite.questions[qid];
      if (!q) fail(`${where} expects unknown question "${qid}".`);
      if (expected === null) continue;
      if (q.type === 'noul' && typeof expected !== 'boolean') fail(`${where}: "${qid}" is a noul, expect true or false.`);
      if (q.type === 'choice' && ![].concat(expected).every(v => typeof v === 'string' && v in q.criteria)) fail(`${where}: "${qid}" expects an option that is not in its criteria.`);
      if (q.type === 'score' && !(Number.isInteger(expected) && expected >= 0 && expected < q.criteria.length)) fail(`${where}: "${qid}" expects a level index 0–${q.criteria.length - 1}.`);
    }
  });
  if (suite.target !== undefined && !(suite.target > 0.5 && suite.target <= 1)) fail('"target" must be between 0.5 and 1.');
}

// Normalize one answer into a prediction plus a certainty in [0.5, 1] for thresholds.
export function readAnswer(question, answer) {
  if (question.type === 'noul') return { predicted: answer.noul >= 0.5, p: answer.noul, certainty: Math.max(answer.noul, 1 - answer.noul) };
  if (question.type === 'choice') return { predicted: answer.choice, p: answer.probabilities[answer.choice], certainty: answer.confidence };
  const level = Number(Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0][0]);
  return { predicted: level, p: answer.probabilities[String(level)], certainty: answer.confidence, score: answer.score };
}

const isCorrect = (expected, predicted) => [].concat(expected).includes(predicted);

// Smallest certainty cutoff whose auto-handled cases reach the target accuracy.
export function suggestThreshold(rows, target) {
  const cutoffs = [...new Set(rows.map(r => r.certainty))].sort((a, b) => a - b);
  for (const t of cutoffs) {
    const auto = rows.filter(r => r.certainty >= t);
    const accuracy = auto.filter(r => r.correct).length / auto.length;
    if (accuracy >= target) return { threshold: +t.toFixed(3), coverage: auto.length / rows.length, accuracy, automated: auto.length };
  }
  return null;
}

function reverseChoiceOptions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
    q.type === 'choice' ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).reverse()) } : q]));
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
};

async function runModel({ suite, judgeFor, model, concurrency, orderCheck, now }) {
  const judge = judgeFor(model);
  const hasChoice = Object.values(suite.questions).some(q => q.type === 'choice');
  const reversed = reverseChoiceOptions(suite.questions);
  const results = await pool(suite.cases, concurrency, async (c, index) => {
    const id = String(c.id ?? index + 1);
    const started = now();
    let response;
    try { response = await judge(c.state, suite.questions); }
    catch (error) { return { id, error: error.message }; }
    const ms = now() - started;
    const answers = {};
    for (const [qid, q] of Object.entries(suite.questions)) answers[qid] = readAnswer(q, response.answers[qid]);
    let orderFlips = null;
    if (orderCheck && hasChoice) {
      try {
        const again = await judge(c.state, reversed);
        orderFlips = Object.entries(suite.questions).filter(([qid, q]) => q.type === 'choice' && again.answers[qid].choice !== response.answers[qid].choice).map(([qid]) => qid);
      } catch { orderFlips = null; }
    }
    return { id, tags: c.tags ?? [], ms, inputTokens: response.usage?.input_tokens ?? null, resolvedModel: response.model, answers, orderFlips };
  });
  return results;
}

function summarize(suite, results, target) {
  const ok = results.filter(r => !r.error);
  const questions = {};
  for (const [qid, q] of Object.entries(suite.questions)) {
    const rows = [];
    ok.forEach(r => {
      const c = suite.cases.find((x, i) => String(x.id ?? i + 1) === r.id);
      const expected = c.expect?.[qid];
      if (expected === undefined || expected === null) return;
      const a = r.answers[qid];
      rows.push({ id: r.id, tags: r.tags, expected, predicted: a.predicted, p: a.p, certainty: a.certainty, correct: isCorrect(expected, a.predicted) });
    });
    const tags = {};
    for (const row of rows) for (const tag of row.tags) {
      tags[tag] ??= { n: 0, correct: 0 }; tags[tag].n++; if (row.correct) tags[tag].correct++;
    }
    const correct = rows.filter(r => r.correct).length;
    questions[qid] = {
      type: q.type, scored: rows.length, correct, accuracy: rows.length ? correct / rows.length : null,
      threshold: rows.length ? suggestThreshold(rows, target) : null, tags,
      misses: rows.filter(r => !r.correct).map(({ id, expected, predicted, certainty }) => ({ id, expected, predicted, certainty: +certainty.toFixed(3) })),
      orderFlips: q.type === 'choice' ? ok.filter(r => r.orderFlips).filter(r => r.orderFlips.includes(qid)).map(r => r.id) : undefined,
    };
  }
  const latencies = ok.map(r => r.ms);
  const tokens = ok.map(r => r.inputTokens).filter(Number.isFinite);
  const avgTokens = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null;
  return {
    resolvedModels: [...new Set(ok.map(r => r.resolvedModel))],
    requests: results.length, errors: results.filter(r => r.error).map(r => ({ id: r.id, error: r.error })),
    orderChecked: ok.some(r => r.orderFlips !== null && r.orderFlips !== undefined),
    latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
    avgInputTokens: avgTokens === null ? null : Math.round(avgTokens),
    estCostPer1kCalls: avgTokens === null ? null : +(avgTokens * 1000 * PRICE_PER_INPUT_TOKEN).toFixed(4),
    questions,
  };
}

function compareRuns(suite, baseRows, otherRows) {
  const flips = {};
  for (const qid of Object.keys(suite.questions)) {
    flips[qid] = [];
    baseRows.forEach((a, i) => {
      const b = otherRows[i];
      if (a.error || b?.error) return;
      const x = a.answers[qid], y = b.answers[qid];
      if (x.predicted !== y.predicted) flips[qid].push({ id: a.id, from: x.predicted, to: y.predicted });
    });
  }
  return flips;
}

export async function evaluateSuite({ suite, judgeFor, models, concurrency = 4, orderCheck = false, target, minAccuracy, now = () => performance.now() }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be an integer from 1 to 16.');
  const goal = target ?? suite.target ?? 0.95;
  const runs = [];
  for (const model of models) {
    const rows = await runModel({ suite, judgeFor, model, concurrency, orderCheck, now });
    runs.push({ model, rows, summary: summarize(suite, rows, goal) });
  }
  const comparisons = runs.slice(1).map(r => ({ from: runs[0].model, to: r.model, flips: compareRuns(suite, runs[0].rows, r.rows) }));
  const failing = minAccuracy === undefined ? [] : runs.flatMap(r => Object.entries(r.summary.questions)
    .filter(([, q]) => q.accuracy !== null && q.accuracy < minAccuracy).map(([qid, q]) => ({ model: r.model, question: qid, accuracy: q.accuracy })));
  const allFailed = runs.every(r => r.summary.errors.length === r.summary.requests);
  const anyErrors = runs.some(r => r.summary.errors.length);
  return {
    version: 1, tool: 'eval', suite: suite.name ?? null, cases: suite.cases.length, target: goal, minAccuracy: minAccuracy ?? null,
    status: allFailed ? 'error' : failing.length ? 'failed' : anyErrors ? 'review' : 'passed',
    failing, runs: runs.map(r => ({ model: r.model, ...r.summary })), comparisons,
    note: 'Accuracy is measured against your labels on your cases. Thresholds are suggestions for this suite, not guarantees.',
  };
}

export const evalExitCode = report => ({ passed: 0, failed: 1, review: 2, error: 3 })[report.status];
