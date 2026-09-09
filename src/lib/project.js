import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

/** Throws unless `cwd` looks like an Expo app. */
export function assertExpoProject(cwd) {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json in ${cwd} — run native-sim from an Expo project root.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.expo) {
    throw new Error(`${pkg.name ?? basename(cwd)} has no "expo" dependency — native-sim targets Expo apps.`);
  }
  return pkg;
}

/** Best-effort read of app.json / app.config.json. Config plugins in JS are ignored. */
export function readAppConfig(cwd) {
  for (const file of ['app.json', 'app.config.json']) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')).expo ?? {};
    } catch {
      return {};
    }
  }
  return {};
}


export function defaultRepoName(cwd) {
  return basename(cwd).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'expo-app';
}
