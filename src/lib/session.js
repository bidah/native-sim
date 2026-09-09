import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Inside .git so it is never committed and dies with the clone. */
const file = (cwd) => join(cwd, '.git', 'native-sim-session.json');

export function saveSession(cwd, data) {
  if (!existsSync(join(cwd, '.git'))) return;
  writeFileSync(file(cwd), JSON.stringify({ ...data, startedAt: Date.now() }, null, 2));
}

export function loadSession(cwd) {
  const path = file(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function clearSession(cwd) {
  rmSync(file(cwd), { force: true });
}
