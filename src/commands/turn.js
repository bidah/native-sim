import { createInterface } from 'node:readline';
import * as gh from '../lib/gh.js';
import { ok, info, warn, step, bold, dim, cyan } from '../lib/ui.js';

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const KEYS = [
  'NATIVE_SIM_TURN_KEY_ID',
  'NATIVE_SIM_TURN_KEY_TOKEN',
  'NATIVE_SIM_TURN_URL',
  'NATIVE_SIM_TURN_USERNAME',
  'NATIVE_SIM_TURN_CREDENTIAL',
  'NATIVE_SIM_STUN_URL',
];

/**
 * TURN config lives in repo secrets, never workflow inputs: dispatch inputs are
 * visible to anyone who can read the repo, and on a public repo that is everyone.
 *
 * With a Cloudflare Realtime key the runner mints a short-lived credential per
 * session, so nothing long-lived is stored and a leak expires by itself.
 */
export async function turn(cwd, flags) {
  gh.requireAuth();
  const repo = gh.nameWithOwner(cwd);
  if (!repo) throw new Error('no GitHub remote here — run native-sim up first');

  if (flags.status) {
    const names = gh.listSecrets(cwd);
    console.log(`\n  ${bold(repo)}`);
    for (const k of KEYS) console.log(`  ${names.includes(k) ? cyan('set  ') : dim('unset')} ${k}`);
    console.log('');
    return;
  }

  step(`Configure TURN for ${bold(repo)}`);
  console.log(dim('  A cloudflared quick tunnel carries no UDP, so WebRTC needs TURN.'));
  console.log(dim('  STUN alone cannot traverse it.'));
  console.log('');
  console.log('  Cloudflare Realtime (recommended — credentials are minted per session):');
  console.log(dim('    dash.cloudflare.com -> Realtime -> TURN Keys -> Create'));
  console.log(dim('    then paste the Key ID and its API token below'));
  console.log('');
  console.log(dim('  Leave the Key ID blank to enter a static TURN URL instead.'));
  console.log('');

  const keyId = await prompt('  Realtime TURN Key ID (blank for static): ');

  if (keyId) {
    const token = await prompt('  TURN Key API token: ', { hidden: true });
    if (!token) throw new Error('a TURN key API token is required');
    gh.setSecret(cwd, 'NATIVE_SIM_TURN_KEY_ID', keyId);
    gh.setSecret(cwd, 'NATIVE_SIM_TURN_KEY_TOKEN', token);
    ok(`stored Realtime TURN key on ${repo}`);
    info('the runner mints a 2h credential per session; nothing long-lived is kept');
  } else {
    const url = await prompt('  TURN URL (turn:host:3478): ');
    if (!url) throw new Error('a TURN URL is required');
    const username = await prompt('  TURN username: ');
    const credential = await prompt('  TURN credential: ', { hidden: true });
    gh.setSecret(cwd, 'NATIVE_SIM_TURN_URL', url);
    if (username) gh.setSecret(cwd, 'NATIVE_SIM_TURN_USERNAME', username);
    if (credential) gh.setSecret(cwd, 'NATIVE_SIM_TURN_CREDENTIAL', credential);
    ok(`stored static TURN credentials on ${repo}`);
    warn('static credentials do not expire — prefer a Realtime key');
  }

  console.log(`\nNext: ${dim('native-sim up --transport webrtc --public')}`);
}
