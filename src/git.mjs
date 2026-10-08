import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { run, readBounded, redact, sensitive } from './util.mjs';

async function git(cwd, args) {
  const result = await run(['git', ...args], { cwd });
  if (result.code !== 0) throw new Error(`Git evidence unavailable: ${redact(result.stderr.trim() || result.error || 'command failed')}`);
  return result.stdout;
}

export async function repositoryRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function collectGit(root, base) {
  // Resolve revisions before using them in diff; options and pathspecs cannot masquerade as revisions.
  const baseCommit = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const common = ['--no-ext-diff', '--no-textconv', '--no-renames', baseCommit, '--'];
  const raw = await git(root, ['diff', '--binary', ...common]);
  const tracked = (await git(root, ['diff', '--name-only', '-z', ...common])).split('\0').filter(Boolean);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  if (paths.length > 200) throw new Error('More than 200 changed files. Narrow the work before verifying.');
  const hash = createHash('sha256').update(head).update(baseCommit).update(raw);
  const files = [];
  for (const path of paths) {
    const full = resolve(root, path);
    if (relative(root, full).startsWith('..')) throw new Error('Git returned a path outside the repository.');
    let content = '', unavailable = null;
    if (untracked.includes(path)) {
      try {
        const data = await readBounded(full);
        hash.update(path).update(data);
        if (data.includes(0)) unavailable = 'binary';
        else content = data.toString('utf8');
      } catch (error) {
        // Symlinks and large untracked files are not followed or silently approved.
        hash.update(path).update(error.message);
        unavailable = 'unreadable_or_large';
      }
    } else {
      content = await git(root, ['diff', '--unified=3', ...common.slice(0, -1), '--', path]);
      if (content.includes('Binary files') || content.includes('GIT binary patch')) unavailable = 'binary';
    }
    if (sensitive(path)) { content = ''; unavailable = 'sensitive_path'; }
    files.push({ path, excerpt: unavailable ? '' : redact(content).slice(0, 6000),
      incomplete: unavailable || (content.length > 6000 ? 'truncated' : null) });
  }
  return { head, baseCommit, fingerprint: hash.digest('hex'), files };
}
