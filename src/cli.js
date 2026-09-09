import { init } from './commands/init.js';
import { up } from './commands/up.js';
import { status } from './commands/status.js';
import { down } from './commands/down.js';
import { doctor } from './commands/doctor.js';
import { upload } from './commands/upload.js';
import { r2Setup } from './commands/r2.js';
import { turn } from './commands/turn.js';
import { bold, dim, cyan } from './lib/ui.js';

const HELP = `
${bold('native-sim')} — stream an iOS Simulator of your Expo app from a GitHub Actions runner

${bold('USAGE')}
  native-sim <command> [options]

${bold('COMMANDS')}
  up        Push, build on a macOS runner, and open the live simulator ${dim('(default)')}
  init      Write .github/workflows/native-sim.yml and the auth gate
  status    Show the current session and its stream URL
  down      Cancel the run and tear the stream down ${dim('(--all for every session)')}
  doctor    Check prerequisites
  upload    Upload a simulator build to this repo's release ${dim('(--r2 for R2)')}
  r2        Configure R2 credentials, for --r2 ${dim('(--status to inspect)')}
  turn      Store TURN credentials as repo secrets, for --transport webrtc

${bold('OPTIONS')} ${dim('(native-sim up)')}
  --minutes <n>     How long to hold the stream open        ${dim('default 30, max 350')}
  --device <name>   Simulator device                        ${dim('default "iPhone 17 Pro"')}
  --app-file <p>    Upload a local .app/.tar.gz and run it ${dim('(hosted on this repo)')}
  --app-release <a> Run an asset already on this repo's native-sim-build release
  --r2              Host --app-file on Cloudflare R2 instead ${dim('(needs: native-sim r2)')}
  --app <url>       Install an already-built simulator .app from a URL
                    ${dim('no source is pushed; the repo holds only the workflow')}
  --mode <m>        build | app | go                       ${dim('default build')}
  --scheme <name>   Xcode scheme                            ${dim('default: generated workspace name')}
  --runner <label>  Runner label                            ${dim('default macos-26')}
  --repo <name>     Repo name when creating one
  --transport <t>   http | webrtc                          ${dim('default http; webrtc is paid + no better')}
  --codec <c>       mjpeg | h264                           ${dim('default mjpeg; h264 is dead on GH runners')}
  --max-dimension   Cap captured px; 0 = native            ${dim('default 900; lower = snappier, softer')}
  --fps <n>         MJPEG frame rate                       ${dim('default 30; serve-sim default is 60')}
  --quality <n>     MJPEG quality 0.05-1                   ${dim('default 0.7')}
  --agent           Also expose an agent-device proxy so a coding agent can
                    drive the simulator ${dim('(prints the connect command)')}
  --export          Also download the built .app archive ${dim('(--out <dir>)')}
  --no-cache        Force a full native rebuild ${dim('(cache is on by default)')}
  --public          Create the repo public ${dim('(unlimited free macOS minutes)')}
  --message <msg>   Commit message
  --no-open         Do not open the browser

${bold('EXAMPLES')}
  ${cyan('native-sim up --public --minutes 45')}
  ${cyan('native-sim up --public --agent')}          ${dim('# stream + agent-device control')}
  ${cyan('native-sim up --mode go --device "iPhone 17"')}
  ${cyan('native-sim up --app https://expo.dev/artifacts/eas/xxxx.tar.gz --public')}
  ${cyan('native-sim up --app-file ./MyApp.app')}   ${dim('# hosted on your own repo')}
  ${cyan('native-sim upload ./build/MyApp.app.tar.gz')}
  ${cyan('native-sim down')}
`;

const NEEDS_VALUE = new Set(['minutes', 'device', 'mode', 'scheme', 'runner', 'repo', 'message', 'app', 'app-file', 'app-release', 'expires', 'out', 'codec', 'max-dimension', 'fps', 'quality', 'transport']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    if (NEEDS_VALUE.has(key)) {
      value ??= argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      flags[key] = key === 'minutes' ? Number(value) : value;
      continue;
    }
    flags[key] = value ?? true;
  }

  flags._positional = positional.slice(1);
  return { command: positional[0] ?? 'up', flags };
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.help || flags.h || command === 'help') {
    console.log(HELP);
    return;
  }

  if (flags.minutes !== undefined && (!Number.isFinite(flags.minutes) || flags.minutes < 1 || flags.minutes > 350)) {
    throw new Error('--minutes must be between 1 and 350 (GitHub kills hosted jobs at 6 hours)');
  }
  if (flags.transport && !['http', 'webrtc'].includes(flags.transport)) {
    throw new Error(`--transport must be "http" or "webrtc", got "${flags.transport}"`);
  }
  if (flags.codec && !['h264', 'mjpeg', 'auto'].includes(flags.codec)) {
    throw new Error(`--codec must be "h264", "mjpeg" or "auto", got "${flags.codec}"`);
  }
  if (flags.mode && !['build', 'app', 'go'].includes(flags.mode)) {
    throw new Error(`--mode must be "build", "app" or "go", got "${flags.mode}"`);
  }
  if (typeof flags.app === 'string' && !/^https?:\/\//.test(flags.app)) {
    throw new Error(
      `--app needs a URL the runner can download, got "${flags.app}".\n` +
        `A local path will not work — the runner cannot reach your machine.\n` +
        `Use an EAS build URL, a release asset, or any reachable https:// link.`,
    );
  }

  const cwd = process.cwd();
  const commands = { up, init, status, down, doctor, upload, r2: r2Setup, turn };
  const handler = commands[command];
  if (!handler) throw new Error(`Unknown command "${command}". Try: native-sim help`);

  await handler(cwd, flags);
}
