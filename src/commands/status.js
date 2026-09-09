import * as gh from '../lib/gh.js';
import { loadSession } from '../lib/session.js';
import { info, ok, warn, dim, bold, cyan, green, red } from '../lib/ui.js';

export async function status(cwd) {
  const session = loadSession(cwd);
  if (!session) {
    info('no native-sim session recorded for this project');
    return;
  }

  const run = gh.getRun(cwd, session.runId);
  const commitStatus = gh.readStatus(cwd, session.repo, session.sha, session.context);
  const age = Math.round((Date.now() - session.startedAt) / 60000);

  console.log('');
  console.log(`  ${bold('session')}  ${session.session} ${dim(`· started ${age}m ago`)}`);
  console.log(`  ${bold('repo')}     ${session.repo}`);
  console.log(`  ${bold('run')}      ${cyan(session.url)}`);
  console.log(`  ${bold('state')}    ${run ? `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}` : dim('unknown')}`);

  if (commitStatus?.state === 'success' && commitStatus.target_url) {
    console.log(`  ${bold('stream')}   ${green('●')} ${commitStatus.target_url}`);
  } else if (commitStatus) {
    console.log(`  ${bold('stream')}   ${red('○')} ${commitStatus.description ?? commitStatus.state}`);
  } else {
    console.log(`  ${bold('stream')}   ${dim('not published yet')}`);
  }
  console.log('');
}
