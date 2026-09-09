import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import { sh, sleep, open as openUrl } from '../lib/proc.js';
import { assertExpoProject, defaultRepoName } from '../lib/project.js';
import { scaffold, WORKFLOW_PATH } from './init.js';
import { saveSession } from '../lib/session.js';
import * as r2 from '../lib/r2.js';
import * as ghrelease from '../lib/ghrelease.js';
import { info, ok, warn, step, spinner, bold, dim, cyan, green } from '../lib/ui.js';

const WORKFLOW = 'native-sim.yml';

export async function up(cwd, flags) {
  const appFile = flags['app-file'];
  const appRelease = flags['app-release'];
  const mode = flags.app || appFile || appRelease ? 'app' : (flags.mode ?? 'build');

  // R2 uploads happen before any git work, so a bad config fails fast rather
  // than after a push and a dispatch. A GitHub-hosted upload cannot: it needs
  // the repo to exist, so it runs further down, once `repo` is known.
  let appUrl = flags.app ?? '';
  let appReleaseAsset = appRelease && appRelease !== true ? appRelease : '';
  if (appFile && flags.r2) {
    const config = r2.loadConfig();
    r2.assertConfigured(config);
    step(`Uploading ${bold(appFile)} to R2`);
    const uploaded = r2.upload(config, appFile, { expiresIn: 7200 });
    appUrl = uploaded.url;
    ok(`uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB ${dim('(presigned 2h)')}`);
  }

  // In app mode nothing is compiled from this checkout, so the directory does
  // not have to be an Expo project — the repo only carries the workflow.
  if (mode !== 'app') assertExpoProject(cwd);
  gh.requireAuth();

  step('Preparing repository');

  if (!git.isRepo(cwd)) {
    git.init(cwd);
    ok('git init');
  }

  const branch = git.currentBranch(cwd);
  const message = flags.message ?? `native-sim: ${new Date().toISOString()}`;

  // Commit and push the app *before* scaffolding the workflow. GitHub does not
  // scan the first push to a brand-new empty repo for workflow files, so a
  // workflow shipped in that push is never registered with Actions.
  if (git.isDirty(cwd) || !git.hasCommits(cwd)) {
    git.commitAll(cwd, message);
    ok(`committed on ${bold(branch)}`);
  } else {
    info(`working tree clean on ${bold(branch)}`);
  }

  let repo = gh.nameWithOwner(cwd);
  if (!repo) {
    const name = flags.repo ?? defaultRepoName(cwd);
    const isPublic = Boolean(flags.public);
    step(`Creating ${isPublic ? 'public' : 'private'} repo ${bold(name)}`);
    if (!isPublic) {
      warn(`private repos bill macOS minutes at ${bold('10×')} — use ${dim('--public')} for unlimited free minutes`);
    }
    repo = gh.createRepo(cwd, name, { isPublic, branch });
    ok(`created ${repo}`);
  } else {
    git.push(cwd, branch);
    ok(`pushed to ${repo}`);
    if (!gh.isPublicRepo(cwd)) {
      warn(`${repo} is private — macOS minutes bill at ${bold('10×')} against your quota`);
    }
  }

  // Second push. This one GitHub does scan for workflow files.
  if (scaffold(cwd) || git.isDirty(cwd)) {
    git.commitAll(cwd, 'native-sim: add simulator streaming workflow');
    git.push(cwd, branch);
    ok('pushed native-sim workflow');
  }

  // Now that the repo exists, a local build can be hosted on its own release.
  // The runner fetches it with the job's own token — no third-party account,
  // and nothing publicly downloadable when the release stays a draft.
  if (appFile && !flags.r2) {
    step(`Uploading ${bold(appFile)} to ${bold(repo)}`);
    const uploaded = ghrelease.upload(cwd, repo, appFile);
    appReleaseAsset = uploaded.asset;
    ok(`uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB ${dim(`as ${uploaded.asset}`)}`);
    if (ghrelease.isPubliclyReadable(cwd, repo)) {
      warn('published release on a public repo — the build is downloadable by anyone');
    }
  }

  await assertWorkflowIsDispatchable(cwd, repo, branch);
  await ensureRegistered(cwd, repo, branch);

  const sha = git.headSha(cwd);
  const session = randomBytes(4).toString('hex');
  const gateToken = randomBytes(24).toString('base64url');
  const context = `native-sim/${session}`;

  step('Dispatching build');
  await gh.dispatch(cwd, WORKFLOW, branch, {
    session,
    gate_token: gateToken,
    minutes: String(flags.minutes ?? 30),
    device: flags.device ?? 'iPhone 17 Pro',
    mode,
    app_url: appUrl,
    app_release_asset: appReleaseAsset,
    export_app: flags.export ? 'true' : 'false',
    agent_device: flags.agent ? 'true' : 'false',
    agent_device_version: agentDeviceVersion(),
    transport: flags.transport ?? 'http',
    codec: flags.codec ?? 'mjpeg',
    max_dimension: String(flags['max-dimension'] ?? 900),
    video_fps: String(flags.fps ?? 30),
    video_quality: String(flags.quality ?? 0.7),
    scheme: flags.scheme ?? '',
    cache: flags.cache === false ? 'false' : 'true',
    runner: flags.runner ?? 'macos-26',
  });

  const run = await waitForRun(cwd, session);
  ok(`run ${cyan(run.url)}`);
  saveSession(cwd, { session, runId: run.databaseId, sha, repo, context, url: run.url });

  const base = await waitForStream(cwd, { repo, sha, context, runId: run.databaseId });
  // The runner publishes only the bare tunnel URL; the key never leaves this machine.
  const url = `${base.replace(/\/$/, '')}/?k=${gateToken}`;

  console.log('');
  console.log(`  ${green('●')} ${bold('Simulator is live')}`);
  console.log(`  ${url}`);
  console.log('');
  console.log(dim(`  Anyone with that link can drive the simulator.`));
  console.log(dim(`  Stop it early with: native-sim down`));
  console.log('');

  if (flags.agent) printAgentConnect(base, gateToken);

  if (flags.export) await exportArtifact(cwd, repo, run.databaseId, session, flags.out ?? process.cwd());
  if (flags.open !== false) openUrl(url);
  return url;
}

/**
 * The proxied daemon and the local client should be the same build, so the
 * runner installs whatever this machine already has rather than a floating
 * latest. Falls back to the workflow's own default when agent-device is absent
 * locally — the session still works, you just install the client afterwards.
 */
function agentDeviceVersion() {
  const r = sh('agent-device', ['--version']);
  const version = r.ok ? r.out.trim().split(/\s+/).pop() : '';
  return /^\d+\.\d+\.\d+/.test(version) ? version : '0.20.1';
}

/**
 * The agent-device proxy rides the same tunnel and the same token as the
 * stream, so the connect line is derivable locally — nothing extra has to be
 * published from the runner.
 */
function printAgentConnect(base, gateToken) {
  const daemon = `${base.replace(/\/$/, '')}/agent-device`;
  console.log(`  ${bold('Drive it from an agent')} ${dim('(agent-device)')}`);
  console.log('');
  console.log(cyan(`  agent-device connect proxy \\`));
  console.log(cyan(`    --daemon-base-url ${daemon} \\`));
  console.log(cyan(`    --daemon-auth-token ${gateToken}`));
  console.log('');
  console.log(dim(`  Then: agent-device devices --platform ios`));
  console.log(dim(`        agent-device open <app-id> --platform ios`));
  console.log(dim(`        agent-device snapshot -i`));
  console.log(dim(`  Release it with: agent-device close && agent-device disconnect`));
  console.log('');
}

/** Waits for the build to upload the .app archive, then fetches it. */
async function exportArtifact(cwd, repo, runId, session, dir) {
  const name = `native-sim-app-${session}`;
  const spin = spinner('waiting for the app archive (built after the stream comes up)');
  try {
    await gh.waitForArtifact(cwd, repo, runId, name);
  } finally {
    spin.stop();
  }
  gh.downloadArtifact(cwd, runId, name, dir);
  ok(`exported app archive to ${bold(dir)}`);
}

/**
 * `workflow_dispatch` reads the workflow definition from the default branch, so
 * a workflow that only exists on a feature branch silently isn't dispatchable.
 */
async function assertWorkflowIsDispatchable(cwd, repo, branch) {
  const meta = gh.api(`repos/${repo}`);
  const defaultBranch = meta?.default_branch ?? 'main';
  if (branch === defaultBranch) return;

  const onDefault = gh.api(`repos/${repo}/contents/${WORKFLOW_PATH}?ref=${defaultBranch}`);
  if (onDefault) return;

  throw new Error(
    `${WORKFLOW_PATH} is not on the default branch (${defaultBranch}).\n` +
      `GitHub only exposes workflow_dispatch for workflows present there.\n` +
      `Merge ${branch} into ${defaultBranch}, or run native-sim from ${defaultBranch}.`,
  );
}

/**
 * Actions must register the workflow before it can be dispatched. If polling
 * times out, nudge GitHub by making the workflow file part of a fresh push.
 */
async function ensureRegistered(cwd, repo, branch) {
  const spin = spinner('waiting for GitHub to register the workflow');
  try {
    if (await gh.waitForWorkflowRegistration(cwd, repo, WORKFLOW_PATH, { timeoutMs: 120000 })) return;

    spin.update('nudging GitHub to rescan the workflow');
    const file = join(cwd, WORKFLOW_PATH);
    const body = readFileSync(file, 'utf8').replace(/\n# native-sim-revision:.*\n$/, '\n');
    writeFileSync(file, `${body}# native-sim-revision: ${Date.now()}\n`);
    git.commitAll(cwd, 'native-sim: refresh workflow registration');
    git.push(cwd, branch);

    if (await gh.waitForWorkflowRegistration(cwd, repo, WORKFLOW_PATH, { timeoutMs: 120000 })) return;
  } finally {
    spin.stop();
  }
  throw new Error(
    `GitHub never registered ${WORKFLOW_PATH}.\n` +
      `Check that Actions is enabled: https://github.com/${repo}/settings/actions`,
  );
}

async function waitForRun(cwd, session) {
  const spin = spinner('waiting for GitHub to queue the run');
  for (let i = 0; i < 40; i++) {
    const run = gh.findRun(cwd, WORKFLOW, session);
    if (run) {
      spin.stop();
      return run;
    }
    await sleep(3000);
  }
  spin.stop();
  throw new Error('GitHub never queued the run. Check: gh run list --workflow native-sim.yml');
}

/** Poll the commit status the runner writes once the tunnel is up. */
async function waitForStream(cwd, { repo, sha, context, runId }) {
  const spin = spinner('starting runner');
  const deadline = Date.now() + 45 * 60 * 1000;

  try {
    while (Date.now() < deadline) {
      const status = gh.readStatus(cwd, repo, sha, context);
      if (status?.state === 'success' && status.target_url) return status.target_url;

      const run = gh.getRun(cwd, runId);
      if (run?.status === 'completed') {
        throw new Error(
          `Run finished (${run.conclusion}) without publishing a stream URL.\n` +
            `Logs: gh run view ${runId} --log-failed`,
        );
      }
      spin.update(describe(run));
      await sleep(5000);
    }
  } finally {
    spin.stop();
  }
  throw new Error('Timed out after 45 minutes waiting for the stream URL.');
}

function describe(run) {
  const job = run?.jobs?.[0];
  if (!job) return 'waiting for a macOS runner';
  const active = job.steps?.find((s) => s.status === 'in_progress');
  const done = job.steps?.filter((s) => s.status === 'completed').length ?? 0;
  const total = job.steps?.length ?? 0;
  return active ? `${active.name} ${dim(`(${done}/${total})`)}` : `${job.status.replace('_', ' ')}`;
}
