#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { repositoryRoot } from '../src/git.mjs';
import { initManifest, loadManifest } from '../src/manifest.mjs';
import { verify, verifyExitCode } from '../src/verify.mjs';
import { createClient } from '../src/client.mjs';
import { parseRecords, readRecords, semanticGrep } from '../src/grep.mjs';
import { formatVerify, formatGrep } from '../src/format.mjs';
import { demo } from '../src/demo.mjs';
import { redact } from '../src/util.mjs';

const HELP = `jevtool 0.1.0 — evidence checks and semantic filters

  jevtool init [--task "Fix login failures"]
  jevtool verify [--file .jevtool/acceptance.json] [--base HEAD]
                 [--run-tests] [--judge] [--threshold 0.85] [--json] [--output report.json]
  jevtool grep "filter condition" [file|-] [--format text|jsonl] [--threshold 0.8] [--json]
  jevtool demo [--json]

verify: collects evidence locally. --run-tests executes configured argv commands;
        --judge sends selected, redacted diffs and test output to TypeSafe.
grep: sends records to TypeSafe. Set TYPESAFE_API_KEY (or JEV_API_KEY).
Exit codes: verify 0 supported / 1 failed / 2 review / 3 operational error.
            grep 0 matches / 1 no matches / 2 review / 3 operational error.
demo: creates and removes an isolated Git fixture; requires no API key.
Node.js 20+ and Git required. Packages are not yet published to npm.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, task: { type: 'string' },
    file: { type: 'string' }, base: { type: 'string' }, 'run-tests': { type: 'boolean' },
    judge: { type: 'boolean' }, threshold: { type: 'string' }, json: { type: 'boolean' },
    output: { type: 'string' }, format: { type: 'string' },
  } });
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const [command, ...args] = positionals;
  const allowed = {
    init: ['task'], verify: ['file', 'base', 'run-tests', 'judge', 'threshold', 'json', 'output'],
    grep: ['format', 'threshold', 'json'], demo: ['json'],
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}. Run jevtool --help.`);
  for (const key of Object.keys(values)) if (!allowed[command].includes(key)) throw new Error(`--${key} is not supported for ${command}.`);
  if (command !== 'grep' && args.length) throw new Error(`Unexpected argument for ${command}: ${args[0]}`);
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

main().catch(error => { process.stderr.write(`jevtool: ${redact(error.message)}\n`); process.exitCode = 3; });
