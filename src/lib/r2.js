import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { sh, shx, has } from './proc.js';

const CONFIG_DIR = join(homedir(), '.native-sim');
const CONFIG_PATH = join(CONFIG_DIR, 'r2.json');

/** Env wins over the config file, so CI can override without a file. */
export function loadConfig() {
  const file = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  return {
    accountId: process.env.R2_ACCOUNT_ID ?? file.accountId,
    bucket: process.env.R2_BUCKET ?? file.bucket,
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? file.accessKeyId,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? file.secretAccessKey,
  };
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  return CONFIG_PATH;
}

export const configPath = () => CONFIG_PATH;

export function assertConfigured(config) {
  if (!has('aws')) {
    throw new Error('aws CLI not found — R2 uses the S3 API. Install: brew install awscli');
  }
  const missing = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'].filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `R2 is not configured (missing: ${missing.join(', ')}).\n` +
        `Run: native-sim r2 setup\n` +
        `Or set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.`,
    );
  }
}

const endpoint = (config) => `https://${config.accountId}.r2.cloudflarestorage.com`;

function awsEnv(config) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: config.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
    AWS_DEFAULT_REGION: 'auto',
    // R2 is not EC2; without this the SDK stalls probing instance metadata.
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

const awsArgs = (config) => ['--endpoint-url', endpoint(config), '--region', 'auto'];

export function bucketExists(config) {
  return sh('aws', ['s3api', 'head-bucket', '--bucket', config.bucket, ...awsArgs(config)],
    { env: awsEnv(config) }).ok;
}

export function createBucket(config) {
  shx('aws', ['s3api', 'create-bucket', '--bucket', config.bucket, ...awsArgs(config)],
    { env: awsEnv(config) });
}

/**
 * simctl installs a .app directory, so archive one if that is what we were given.
 * Returns a path to a .tar.gz.
 */
export function ensureArchive(path) {
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  if (!statSync(path).isDirectory()) return path;
  if (!path.endsWith('.app')) throw new Error(`${path} is a directory but not a .app bundle`);

  const out = join(tmpdir(), `${basename(path, '.app')}-${Date.now()}.tar.gz`);
  shx('tar', ['-C', join(path, '..'), '-czf', out, basename(path)]);
  return out;
}

/** Uploads and returns a presigned URL valid for `expiresIn` seconds. */
export function upload(config, filePath, { expiresIn = 3600, prefix = 'native-sim' } = {}) {
  assertConfigured(config);
  const archive = ensureArchive(filePath);
  const key = `${prefix}/${Date.now()}-${randomBytes(6).toString('hex')}-${basename(archive)}`;
  const target = `s3://${config.bucket}/${key}`;

  shx('aws', ['s3', 'cp', archive, target, ...awsArgs(config)], { env: awsEnv(config) });
  const url = shx('aws', ['s3', 'presign', target, '--expires-in', String(expiresIn), ...awsArgs(config)],
    { env: awsEnv(config) });

  return { url, key, bytes: statSync(archive).size, expiresIn };
}
