# Running a prebuilt app from a source-free public repo

Public repos get unlimited GitHub Actions minutes, but putting private source in one to
get them is both a licensing problem and a leak. This flow avoids it entirely: the public
repo holds **only the workflow**, and the app arrives as a prebuilt archive over a URL.

Verified end to end. `bidah/native-sim-runner` contains exactly four files and runs a real
app:

```
.github/native-sim/gate.cjs        5,088 bytes
.github/workflows/native-sim.yml  17,658 bytes
.gitignore                         80 bytes
README.md                         176 bytes
```

**Time to a running app: ~5 min**, versus ~33 building from source.

## 1. Get a simulator build

It must be a **simulator** build. A device `.ipa` cannot run on a simulator; the workflow
checks `CFBundleSupportedPlatforms` and fails with a clear message rather than an opaque
`simctl` error.

| Source | How |
|---|---|
| EAS | a profile with `ios.simulator: true` |
| native-sim | `native-sim up --public --export --out .` builds on a runner and downloads the archive |
| Local Xcode | `-sdk iphonesimulator`, then tar the `.app` |

`--export` matters when the local machine cannot build — it compiles on the runner and
brings back only the finished ~25 MB archive.

Verify before hosting:

```sh
tar -xzf MyApp.app.tar.gz -C /tmp/check
/usr/libexec/PlistBuddy -c 'Print CFBundleSupportedPlatforms:0' /tmp/check/*.app/Info.plist
# must print: iPhoneSimulator
```

## 2. Host it somewhere the runner can fetch

The runner cannot reach your machine, so a local path will not work.

| Option | Privacy | Notes |
|---|---|---|
| **R2 presigned** | private, expiring | `native-sim r2` once, then `native-sim upload` or `--app-file`. Best for private code. |
| **EAS artifact URL** | signed, expires | `eas build:list --json` → `.artifacts.applicationArchiveUrl` |
| **GitHub release asset** | **public forever** | `gh release create <tag> <file>`. Fine for demos, wrong for private builds. |

## 3. Run it from a repo with no source

```sh
mkdir native-sim-runner && cd native-sim-runner
native-sim up --app "<url>" --public --repo native-sim-runner
```

native-sim skips dependency install, fingerprinting, the cache, and the build entirely:

```
⊘ Install JS dependencies    ⊘ Build app
⊘ Fingerprint                ⊘ Save app build to cache
⊘ Restore cached app build   ⊘ Install and launch app
✓ Boot simulator             ✓ Install prebuilt app
✓ Start serve-sim            ✓ Report app installed
✓ Open tunnel and publish URL
```

Or in one step, when the archive is local and R2 is configured:

```sh
native-sim up --app-file ./MyApp.app.tar.gz --public
```

## Why this is the right shape

- **No source in the public repo**, so nothing to leak and nothing that stretches
  GitHub's terms about Actions being used for *that repo's* software.
- **Reusable.** One runner repo can run any build, from any project, by URL.
- **Fast.** No compile at all — a warm-cache build is ~7 min; this is ~5.
- **Cheap.** Public repos are free; a private repo would bill macOS at $0.062/min.

## Gotchas

- **The archive must be `.tar.gz` or `.zip` of a `.app`.** `upload-artifact` zips its
  input and a zipped `.app` loses the executable bits `simctl` needs, which is why the
  export step tars first.
- **Signed URLs expire.** Fetch a fresh one per session; EAS URLs last about an hour.
- **A release asset on a public repo is permanent and public.** Delete it when done:
  `gh release delete <tag> --cleanup-tag`.
- **Running native-sim inside another git repo** used to break `gh repo create`; native-sim now
  requires the working directory to be a repo *root* and will `git init` when it is not.
