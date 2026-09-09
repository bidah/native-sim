import * as r2 from '../lib/r2.js';
import * as ghrelease from '../lib/ghrelease.js';
import * as gh from '../lib/gh.js';
import { ok, info, warn, step, bold, dim, cyan } from '../lib/ui.js';

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export async function upload(cwd, flags) {
  const file = flags._positional?.[0];
  if (!file) throw new Error('usage: native-sim upload <path to .app, .tar.gz or .zip>');

  if (flags.r2) return uploadToR2(cwd, file, flags);
  return uploadToGitHub(cwd, file);
}

/**
 * Default host. The runner's own GITHUB_TOKEN is already scoped to this repo,
 * so an asset here needs no third-party account and no presigned URL that can
 * expire mid-session — and on a private repo it is private for free.
 */
function uploadToGitHub(cwd, file) {
  gh.requireAuth();
  const repo = gh.nameWithOwner(cwd);
  if (!repo) {
    throw new Error(
      'No GitHub repo here yet. Run this from the project you stream, or create one first:\n' +
        '  gh repo create --source . --private',
    );
  }

  step(`Uploading ${bold(file)} to ${bold(repo)}`);
  const result = ghrelease.upload(cwd, repo, file);

  ok(`uploaded ${mb(result.bytes)} as ${dim(result.asset)}`);
  if (ghrelease.isPubliclyReadable(cwd, repo)) {
    warn('this release is published on a public repo — the build is downloadable by anyone');
  } else {
    info('draft release on this repo — only people who can read the repo can fetch it');
  }
  console.log('');
  console.log(dim(`  run it:  native-sim up --app-release ${result.asset}`));
  console.log('');
  return result;
}

function uploadToR2(cwd, file, flags) {
  const config = r2.loadConfig();
  r2.assertConfigured(config);

  step(`Uploading ${bold(file)} to R2`);
  const expiresIn = Number(flags.expires ?? 3600);
  const result = r2.upload(config, file, { expiresIn });

  ok(`uploaded ${mb(result.bytes)} as ${dim(result.key)}`);
  console.log('');
  console.log(`  ${cyan(result.url)}`);
  console.log('');
  info(`presigned for ${Math.round(expiresIn / 60)} min -- fetch a fresh one per session`);
  return result;
}
