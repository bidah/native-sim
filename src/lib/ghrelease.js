import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { sh, shx } from './proc.js';
import { ensureArchive } from './r2.js';

/**
 * Host simulator builds as release assets on the repo the workflow runs in.
 *
 * The runner already has `GH_TOKEN: ${{ github.token }}`, and that token is
 * scoped to exactly this repo — so an asset here is fetchable with no PAT, no
 * third-party account, and no presigned URL to expire mid-session. A private
 * repo's assets are private for free, which is the thing R2 was buying.
 *
 * One stable tag is reused and the asset clobbered, rather than a release per
 * session, so the repo's release list does not fill with build noise.
 */
export const TAG = 'native-sim-build';

/** Draft releases are not listed publicly, so a public repo does not publish your binary. */
export function ensureRelease(cwd, repo, { draft = true } = {}) {
  const existing = sh('gh', ['release', 'view', TAG, '--repo', repo, '--json', 'tagName'], { cwd });
  if (existing.ok) return { created: false };

  shx('gh', [
    'release', 'create', TAG,
    '--repo', repo,
    '--title', 'native-sim builds',
    '--notes', 'Simulator builds uploaded by `native-sim`. Managed automatically; safe to delete.',
    ...(draft ? ['--draft'] : []),
  ], { cwd });
  return { created: true };
}

/** Uploads (or replaces) one archive. Returns what the workflow needs to fetch it. */
export function upload(cwd, repo, filePath, { draft = true } = {}) {
  const archive = ensureArchive(filePath);
  const asset = basename(archive);
  ensureRelease(cwd, repo, { draft });
  // --clobber so re-running with the same build name replaces rather than fails.
  shx('gh', ['release', 'upload', TAG, archive, '--repo', repo, '--clobber'], { cwd });
  return { repo, tag: TAG, asset, bytes: statSync(archive).size };
}

/** True when the repo would expose this asset to anyone (published release on a public repo). */
export function isPubliclyReadable(cwd, repo) {
  const vis = sh('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], { cwd });
  if (!vis.ok || vis.out.trim() !== 'PUBLIC') return false;
  const rel = sh('gh', ['release', 'view', TAG, '--repo', repo, '--json', 'isDraft', '-q', '.isDraft'], { cwd });
  return rel.ok && rel.out.trim() === 'false';
}
