import { createInterface } from 'node:readline';
import * as r2 from '../lib/r2.js';
import { ok, info, warn, step, bold, dim, cyan } from '../lib/ui.js';

/** Reads a line; when `hidden`, suppresses echo so secrets stay off the screen. */
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

export async function r2Setup(cwd, flags) {
  if (flags.status) {
    const config = r2.loadConfig();
    const set = (v) => (v ? cyan('set') : dim('unset'));
    console.log(`\n  ${bold('config')}   ${r2.configPath()}`);
    console.log(`  account   ${config.accountId ?? dim('unset')}`);
    console.log(`  bucket    ${config.bucket ?? dim('unset')}`);
    console.log(`  key id    ${set(config.accessKeyId)}`);
    console.log(`  secret    ${set(config.secretAccessKey)}`);
    if (config.accountId && config.bucket && config.accessKeyId && config.secretAccessKey) {
      console.log(`  reachable ${r2.bucketExists(config) ? cyan('yes') : dim('no')}`);
    }
    console.log('');
    return;
  }

  step('Configure R2');
  console.log(dim('  Create an R2 API token with Object Read & Write at:'));
  console.log(dim('  https://dash.cloudflare.com -> R2 -> Manage API Tokens'));
  console.log('');

  const accountId = await prompt('  Cloudflare account ID: ');
  const bucket = (await prompt('  Bucket name [native-sim-builds]: ')) || 'native-sim-builds';
  const accessKeyId = await prompt('  R2 access key ID: ');
  const secretAccessKey = await prompt('  R2 secret access key: ', { hidden: true });

  const config = { accountId, bucket, accessKeyId, secretAccessKey };
  r2.assertConfigured(config);

  if (r2.bucketExists(config)) {
    info(`bucket ${bold(bucket)} already exists`);
  } else {
    r2.createBucket(config);
    ok(`created bucket ${bold(bucket)}`);
  }

  const path = r2.saveConfig(config);
  ok(`saved ${path} ${dim('(0600)')}`);
  warn('keep this file private -- it holds your R2 secret');
  console.log(`\nNext: ${dim('native-sim upload ./MyApp.app')}`);
}
