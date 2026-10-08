import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';

export const MAX_FILE = 2 * 1024 * 1024;

export function redact(value) {
  let text = String(value);
  for (const name of ['TYPESAFE_API_KEY', 'JEV_API_KEY']) {
    const secret = process.env[name];
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  return text
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
}

export async function readBounded(path, limit = MAX_FILE) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  if (stat.size > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`);
  const data = await readFile(path);
  if (data.length > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`);
  return data;
}

// shell:false is intentional. A manifest stores executable + argv, not shell text.
export function run(command, { cwd, timeoutMs = 30_000, maxBytes = MAX_FILE, env = process.env, truncate = false } = {}) {
  return new Promise((resolve, reject) => {
    // Node's internal test-runner context makes nested `node --test` skip all tests
    // and exit 0. Each configured command must start its own real test process.
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(command[0], command.slice(1), {
      cwd, env: childEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const out = [], err = [];
    let total = 0, overflow = false, timedOut = false, spawnError;
    const stop = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = target => chunk => {
      const remaining = Math.max(0, maxBytes - total);
      total += chunk.length;
      if (remaining) target.push(chunk.subarray(0, remaining));
      if (total > maxBytes) {
        overflow = true;
        if (!truncate) stop();
      }
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (overflow && !truncate) return reject(new Error('Command output exceeded the evidence limit. Narrow the change set.'));
      resolve({ code, signal, timedOut, truncated: overflow, error: spawnError?.code,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

export function matches(path, pattern) {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$').test(path);
}

export function sensitive(path) {
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(path)
    || /(^|\/)(\.ssh|\.aws|\.git)(\/|$)/.test(path);
}
