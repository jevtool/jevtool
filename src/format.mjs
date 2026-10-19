export function formatVerify(report) {
  const lines = [`jevtool verify · ${report.status.toUpperCase()}`, report.task, ''];
  for (const c of report.checks) {
    lines.push(`[${c.status.toUpperCase()}] ${c.description}${c.probability === undefined ? '' : ` · p=${c.probability.toFixed(2)}`}`);
    lines.push(`  ${c.reason}`);
    if (c.files.length) lines.push(`  files: ${c.files.map(f => f.path).join(', ')}`);
    if (c.tests.length) lines.push(`  tests: ${c.tests.join(', ')}`);
  }
  if (report.tests.length) {
    lines.push('', 'Executed test evidence:');
    for (const t of report.tests) {
      lines.push(`  ${t.id}: ${t.status}${t.exitCode === undefined ? '' : ` (exit ${t.exitCode})`}${t.timedOut ? ' · timed out' : ''}`);
    }
  }
  if (report.judgment.error) lines.push('', report.judgment.error);
  if (report.warnings.length) lines.push('', `Review: ${report.warnings.join(', ')}`);
  lines.push('', report.judgment.model ? `Jev: ${report.judgment.model}` : 'No live semantic approval.', report.scope);
  return lines.join('\n') + '\n';
}

export function formatGrep(report) {
  const rows = [...report.matches, ...report.review].sort((a, b) => a.line - b.line);
  return rows.map(r => `${r.source}:${r.line}\t${r.probability.toFixed(3)}\t${r.status}\t${r.text}`).join('\n') + (rows.length ? '\n' : '');
}

const pct = value => value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
const show = value => Array.isArray(value) ? value.join('|') : String(value);

export function formatEval(report) {
  const lines = [`jevtool eval · ${report.suite ?? 'suite'} · ${report.cases} cases · ${report.status.toUpperCase()}`, ''];
  for (const run of report.runs) {
    lines.push(`${run.model}${run.resolvedModels.length ? ` (answered by ${run.resolvedModels.join(', ')})` : ''}`);
    for (const [qid, q] of Object.entries(run.questions)) {
      if (!q.scored) { lines.push(`  ${qid.padEnd(18)} ${q.type.padEnd(6)} no labeled cases`); continue; }
      const tags = Object.entries(q.tags).map(([t, v]) => `${t} ${pct(v.correct / v.n)}`).join(' · ');
      const auto = q.threshold
        ? `auto at ≥${q.threshold.threshold}: ${pct(q.threshold.coverage)} of cases, ${pct(q.threshold.accuracy)} correct`
        : `no cutoff reaches ${pct(report.target)}`;
      lines.push(`  ${qid.padEnd(18)} ${q.type.padEnd(6)} ${pct(q.accuracy).padStart(4)} (${q.correct}/${q.scored})  ${auto}${tags ? `  [${tags}]` : ''}`);
      if (q.orderFlips?.length) lines.push(`  ${''.padEnd(25)} option order changed the answer on: ${q.orderFlips.join(', ')}`);
    }
    const cost = run.estCostPer1kCalls === null ? '' : ` · ${run.avgInputTokens} input tokens/call · ~$${run.estCostPer1kCalls} per 1k calls`;
    lines.push(`  latency p50 ${Math.round(run.latencyMs.p50 ?? 0)} ms · p95 ${Math.round(run.latencyMs.p95 ?? 0)} ms${cost}`);
    if (run.errors.length) lines.push(`  ${run.errors.length} request(s) failed: ${run.errors.slice(0, 3).map(e => `${e.id} ${e.error}`).join('; ')}`);
    const misses = Object.entries(run.questions).flatMap(([qid, q]) => q.misses.map(m => ({ qid, ...m })));
    if (misses.length) {
      lines.push('  misses:');
      for (const m of misses.slice(0, 12)) lines.push(`    ${m.id} ${m.qid}: got ${show(m.predicted)}, expected ${show(m.expected)} (certainty ${m.certainty})`);
      if (misses.length > 12) lines.push(`    … ${misses.length - 12} more in --json output`);
    }
    lines.push('');
  }
  for (const c of report.comparisons) {
    const flips = Object.entries(c.flips).filter(([, v]) => v.length);
    lines.push(`${c.from} → ${c.to}: ${flips.length ? flips.map(([qid, v]) => `${qid} changed on ${v.length} case(s) (${v.slice(0, 5).map(f => `${f.id}: ${show(f.from)}→${show(f.to)}`).join(', ')})`).join('; ') : 'no answers changed'}`);
  }
  if (report.failing.length) lines.push('', `Below --min-accuracy ${pct(report.minAccuracy)}: ${report.failing.map(f => `${f.model} ${f.question} ${pct(f.accuracy)}`).join(', ')}`);
  lines.push('', report.note);
  return lines.join('\n') + '\n';
}
