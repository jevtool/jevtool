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
