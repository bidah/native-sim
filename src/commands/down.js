import * as gh from '../lib/gh.js';
import { loadSession, clearSession } from '../lib/session.js';
import { info, ok, warn, dim } from '../lib/ui.js';

const WORKFLOW = 'native-sim.yml';

export async function down(cwd, flags) {
  gh.requireAuth();

  // The session file only ever remembers the most recent `up`, so --all is the
  // only way to catch sessions started before this one.
  if (flags.all) {
    const runs = gh.inFlightRuns(cwd, WORKFLOW);
    if (runs.length === 0) {
      info('no native-sim runs in flight');
      clearSession(cwd);
      return;
    }
    for (const run of runs) {
      if (gh.cancelRun(cwd, run.databaseId)) ok(`cancelled ${run.databaseId} ${dim(run.displayTitle ?? '')}`);
      else warn(`could not cancel ${run.databaseId} — ${run.url}`);
    }
    clearSession(cwd);
    return;
  }

  const session = loadSession(cwd);
  if (!session) {
    info(`no native-sim session recorded ${dim('(try: native-sim down --all)')}`);
    return;
  }

  const run = gh.getRun(cwd, session.runId);
  if (run?.status === 'completed') {
    info(`run already finished (${run.conclusion})`);
  } else if (gh.cancelRun(cwd, session.runId)) {
    ok(`cancelled run ${session.runId} — the stream and the runner shut down together`);
  } else {
    warn(`could not cancel run ${session.runId}; cancel it at ${session.url}`);
  }

  const others = gh.inFlightRuns(cwd, WORKFLOW).filter((r) => r.databaseId !== session.runId);
  if (others.length) {
    warn(`${others.length} other native-sim run(s) still in flight — ${dim('native-sim down --all')}`);
  }

  clearSession(cwd);
}
