import { realpathSync } from 'node:fs';
import { sh, shx } from './proc.js';

/**
 * True only when `cwd` is itself a repo root. `--is-inside-work-tree` is true for
 * any subdirectory of a repo, which would make native-sim skip `git init` inside a
 * monorepo and then fail in `gh repo create`, which requires a repo root.
 */
export function isRepo(cwd) {
  const r = sh('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!r.ok) return false;
  try {
    return realpathSync(r.out) === realpathSync(cwd);
  } catch {
    return false;
  }
}

export function init(cwd) {
  shx('git', ['init', '-b', 'main'], { cwd });
}

export function currentBranch(cwd) {
  const r = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.ok && r.out !== 'HEAD' ? r.out : 'main';
}

export function headSha(cwd) {
  return shx('git', ['rev-parse', 'HEAD'], { cwd });
}

export function isDirty(cwd) {
  return sh('git', ['status', '--porcelain'], { cwd }).out.length > 0;
}

export function hasCommits(cwd) {
  return sh('git', ['rev-parse', '--verify', 'HEAD'], { cwd }).ok;
}

export function commitAll(cwd, message) {
  shx('git', ['add', '-A'], { cwd });
  // `git commit` exits non-zero when there is nothing staged; treat that as fine.
  const r = sh('git', ['commit', '-m', message], { cwd });
  if (!r.ok && !/nothing to commit/i.test(r.out + r.err)) {
    throw new Error(`git commit failed\n${r.err || r.out}`);
  }
}

export function remoteUrl(cwd, name = 'origin') {
  const r = sh('git', ['remote', 'get-url', name], { cwd });
  return r.ok ? r.out : null;
}

export function push(cwd, branch) {
  shx('git', ['push', '-u', 'origin', branch], { cwd });
}

/** Ensure a .gitignore exists that covers the usual Expo build noise. */
export const GITIGNORE = `node_modules/
.expo/
dist/
web-build/
ios/
android/
*.log
.DS_Store
.env*.local
`;
