#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { repositoryRoot } from '../src/git.mjs';
import { initManifest, loadManifest } from '../src/manifest.mjs';
import { verify, verifyExitCode } from '../src/verify.mjs';
import { createClient, resolveProvider, apiKeyFor } from '../src/client.mjs';
import { parseRecords, readRecords, semanticGrep } from '../src/grep.mjs';
import { formatVerify, formatGrep, formatEval } from '../src/format.mjs';
import { demo } from '../src/demo.mjs';
import { loadSuite, listExamples, evaluateSuite, evalExitCode } from '../src/eval.mjs';
import { redact } from '../src/util.mjs';

const VERSION = '0.3.1';
const HELP = `jevtool ${VERSION} — test Jev judgments, check agent deliveries, filter by meaning

  jevtool eval <suite.json | example:NAME> [--model jev-1.13.0] [--compare jev-1.14.0]
               [--order-check] [--target 0.95] [--min-accuracy 0.9] [--concurrency 4]
               [--json] [--output report.json]
               [--provider typesafe|openrouter] [--base-url http://localhost:8000]
  jevtool eval --examples
  jevtool eval example:NAME --save my-suite.json

  jevtool init [--task "Fix login failures"]
  jevtool verify [--file .jevtool/acceptance.json] [--base HEAD]
                 [--run-tests] [--judge] [--threshold 0.85] [--json] [--output report.json]
  jevtool grep "filter condition" [file|-] [--format text|jsonl] [--threshold 0.8] [--json]
  jevtool demo [--json]

verify: collects evidence locally. --run-tests executes configured argv commands;
        --judge sends selected, redacted diffs and test output to TypeSafe.
grep: sends records to TypeSafe. Set TYPESAFE_API_KEY (or JEV_API_KEY).
eval: runs every labeled case through a decision model and reports accuracy, misses,
      a suggested confidence cutoff, and which answers change between models.
      --provider openrouter compares any System One model on OpenRouter (Jev, Clef,
      Solar Decide, Kev, …) with one OPENROUTER_API_KEY; --base-url targets a
      self-hosted /v1/systemone server.
Exit codes: eval 0 passed / 1 below --min-accuracy / 2 some requests failed / 3 error.
            verify 0 supported / 1 failed / 2 review / 3 operational error.
            grep 0 matches / 1 no matches / 2 review / 3 operational error.
demo: creates and removes an isolated Git fixture; requires no API key.
Node.js 20+ required; Git for verify. Docs: https://jevtool.dev/docs
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, task: { type: 'string' },
    file: { type: 'string' }, base: { type: 'string' }, 'run-tests': { type: 'boolean' },
    judge: { type: 'boolean' }, threshold: { type: 'string' }, json: { type: 'boolean' },
    output: { type: 'string' }, format: { type: 'string' },
    model: { type: 'string' }, compare: { type: 'string' }, 'order-check': { type: 'boolean' },
    target: { type: 'string' }, 'min-accuracy': { type: 'string' }, concurrency: { type: 'string' },
    examples: { type: 'boolean' }, save: { type: 'string' }, provider: { type: 'string' }, 'base-url': { type: 'string' },
  } });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, ...args] = positionals;
  const allowed = {
    init: ['task'], verify: ['file', 'base', 'run-tests', 'judge', 'threshold', 'json', 'output'],
    grep: ['format', 'threshold', 'json'], demo: ['json'],
    eval: ['model', 'compare', 'order-check', 'target', 'min-accuracy', 'concurrency', 'json', 'output', 'examples', 'save', 'provider', 'base-url'],
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}. Run jevtool --help.`);
  for (const key of Object.keys(values)) if (!allowed[command].includes(key)) throw new Error(`--${key} is not supported for ${command}.`);
  if (!['grep', 'eval'].includes(command) && args.length) throw new Error(`Unexpected argument for ${command}: ${args[0]}`);
  if (command === 'init') {
    const root = await repositoryRoot(process.cwd());
    const path = await initManifest(root, values.task);
    process.stdout.write(`Created ${path}\nEdit the criteria and test commands, then run jevtool verify.\n`);
  } else if (command === 'verify') {
    const root = await repositoryRoot(process.cwd());
    const manifest = await loadManifest(resolve(root, values.file ?? '.jevtool/acceptance.json'));
    if (values.base) manifest.base = values.base;
    const report = await verify({ root, manifest, runTests: values['run-tests'],
      judge: values.judge ? createClient() : undefined, threshold: values.threshold === undefined ? 0.85 : Number(values.threshold) });
    if (values.output) await writeFile(resolve(process.cwd(), values.output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatVerify(report));
    process.exitCode = verifyExitCode(report);
  } else if (command === 'eval') {
    await runEval(args, values);
  } else if (command === 'grep') {
    if (!args.length || args.length > 2) throw new Error('Usage: jevtool grep "condition" [file|-]');
    let records;
    if (!args[1] || args[1] === '-') {
      if (process.stdin.isTTY) throw new Error('Provide a file or pipe records to stdin.');
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Input exceeds 2 MiB.');
        chunks.push(chunk);
      }
      records = parseRecords(Buffer.concat(chunks).toString('utf8'), 'stdin', values.format);
    } else records = await readRecords(args[1], values.format);
    const report = await semanticGrep({ query: args[0], records, judge: createClient(),
      threshold: values.threshold === undefined ? 0.8 : Number(values.threshold) });
    process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatGrep(report));
    if (!values.json) process.stderr.write(`${report.matches.length} matches · ${report.review.length} need review · ${report.rejected} rejected\n`);
    process.exitCode = report.review.length ? 2 : report.matches.length ? 0 : 1;
  } else {
    const report = await demo();
    process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : 'DEMO · real test execution, no model request\n\n' + formatVerify(report));
    // A successful demo intentionally finds a broken delivery; it is not a CI check.
  }
}

const fraction = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0 && n <= 1)) throw new Error(`--${name} must be a number between 0 and 1.`);
  return n;
};

async function runEval(args, values) {
  if (values.examples) {
    for (const e of await listExamples()) process.stdout.write(`example:${e.name.padEnd(22)} ${String(e.cases).padStart(3)} cases  ${e.description}\n`);
    return;
  }
  if (args.length !== 1) throw new Error('Usage: jevtool eval <suite.json | example:NAME>. Run jevtool eval --examples to list examples.');
  const { suite } = await loadSuite(args[0]);
  if (values.save) {
    await writeFile(resolve(process.cwd(), values.save), JSON.stringify(suite, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(`Saved ${values.save}. Edit the questions and cases, then run jevtool eval ${values.save}\n`);
    return;
  }
  const spec = resolveProvider({ provider: values.provider, baseUrl: values['base-url'] });
  if (!spec.selfHosted && !apiKeyFor(spec)) {
    throw new Error(`No ${spec.keyEnv[0]} found, so no cases were sent. ${spec.keyHelp}, then rerun.`);
  }
  // A suite's model is written for one provider; other providers use their own default.
  const suiteModel = spec.name === 'typesafe' ? suite.model : undefined;
  const primary = values.model ?? suiteModel ?? process.env.JEV_MODEL ?? spec.defaultModel;
  const models = [primary, ...(values.compare ? values.compare.split(',').map(m => m.trim()).filter(Boolean) : [])];
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  const report = await evaluateSuite({ suite, models, concurrency, orderCheck: values['order-check'],
    target: fraction(values.target, 'target'), minAccuracy: fraction(values['min-accuracy'], 'min-accuracy'),
    judgeFor: model => createClient({ model, provider: spec.name, baseUrl: values['base-url'] }) });
  if (values.output) await writeFile(resolve(process.cwd(), values.output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatEval(report));
  process.exitCode = evalExitCode(report);
}

main().catch(error => { process.stderr.write(`jevtool: ${redact(error.message)}\n`); process.exitCode = 3; });
