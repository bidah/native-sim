# native-sim

CLI that builds Expo apps on GitHub-hosted macOS runners and streams the running iOS
Simulator back to a browser. See `README.md`, `docs/how-the-connection-works.md`, and
`.claude/skills/native-sim/`.

## Never build iOS locally

**Do not run `expo prebuild`, `pod install`, `xcodebuild`, or any local iOS build for
this project or the apps under `test/`.** Offloading those builds is the entire point of
this project — building locally defeats it.

Build on GitHub Actions instead:

```sh
native-sim up --public                    # build + stream
native-sim up --public --export           # build + stream + download the .app archive
native-sim up --app <url> --public        # run an already-built app, no compile at all
```

To get a build artifact onto this machine, use `--export`; it downloads only the
finished ~25 MB archive.

**Why it matters beyond principle:** this machine runs near a full disk, and an RN
DerivedData tree is several GB. A local build has already failed here with `ENOSPC` and
had to be cleaned up.

The one exception is a deliberate, user-requested diagnostic — for example running
`expo prebuild` once to check that it succeeds non-interactively. Clean up afterwards
(`rm -rf ios build` and revert files prebuild edited); it is gitignored but it is not
free.

## Verifying changes

Prefer evidence over inspection:

- `actionlint` the workflow after editing `templates/native-sim.yml` (it has caught real
  bugs, including that GitHub Actions expressions have no arithmetic operators).
- Test the auth gate against a local upstream rather than reasoning about it.
- For a live session, check what the preview page advertises:
  `curl -sL -c j -b j "$URL/?k=$KEY" | grep -oE 'wss://[^"]{0,70}'` — it must be the
  tunnel hostname, never `127.0.0.1`.
