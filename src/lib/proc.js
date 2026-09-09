import { spawnSync, spawn } from 'node:child_process';

/** Run a command, capture output. Never throws. */
export function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  };
}

/** Run a command, capture output, throw on non-zero. */
export function shx(cmd, args = [], opts = {}) {
  const r = sh(cmd, args, opts);
  if (!r.ok) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.code})\n${r.err || r.out}`);
  }
  return r.out;
}

/** Run a command with inherited stdio (user sees live output). */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

export function has(cmd) {
  return sh('which', [cmd]).ok;
}

export function open(url) {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
