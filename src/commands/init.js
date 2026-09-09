import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExpoProject } from '../lib/project.js';
import { GITIGNORE } from '../lib/git.js';
import { ok, info, warn, dim } from '../lib/ui.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

export const WORKFLOW_PATH = '.github/workflows/native-sim.yml';

/**
 * Templates carry a version stamp so an out-of-date file (which must be
 * refreshed, or the CLI will dispatch inputs the deployed workflow does not
 * declare) can be told apart from one the user deliberately customised.
 */
const VERSION_RE = /native-sim-template-version:\s*(\d+)/;
const versionOf = (text) => Number(text.match(VERSION_RE)?.[1] ?? 0);
export const GATE_PATH = '.github/native-sim/gate.cjs';

/** Writes the workflow + gate into the project. Returns true if anything changed. */
export function scaffold(cwd, { force = false } = {}) {
  let changed = false;

  for (const [rel, src] of [[WORKFLOW_PATH, 'native-sim.yml'], [GATE_PATH, 'gate.cjs']]) {
    const dest = join(cwd, rel);
    const template = readFileSync(join(TEMPLATES, src), 'utf8');
    if (existsSync(dest) && !force) {
      const existing = readFileSync(dest, 'utf8');
      if (existing === template) continue;

      const [have, want] = [versionOf(existing), versionOf(template)];
      if (have >= want) {
        warn(`${rel} differs from the bundled template ${dim('(native-sim init --force to overwrite)')}`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, template);
      ok(`updated ${rel} ${dim(`(template v${have} → v${want})`)}`);
      changed = true;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, template);
    ok(`wrote ${rel}`);
    changed = true;
  }

  const gitignore = join(cwd, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE);
    ok('wrote .gitignore');
    changed = true;
  }

  return changed;
}

export async function init(cwd, flags) {
  assertExpoProject(cwd);
  const changed = scaffold(cwd, { force: flags.force });
  if (!changed) info('already initialized — nothing to do');
  console.log(`\nNext: ${dim('native-sim up')}`);
}
