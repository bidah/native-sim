---
name: native-sim
description: Stream a live, interactive iOS Simulator of an Expo app from a free GitHub Actions macOS runner using @expo/serve-sim, tunnelled to a browser. Use when asked to preview an Expo/React Native app without a local Mac, to build iOS on GitHub Actions, to share a running simulator with someone, to set up PR simulator previews, or when debugging native-sim itself (workflow not registering, stream "connecting", slow builds, cache misses).
---

# native-sim

Push an Expo app to GitHub, build it on a GitHub-hosted macOS runner, and stream the
running iOS Simulator back to a browser. Public repos get unlimited Actions minutes,
so this is free.

## Quick start

```sh
cd my-expo-app
native-sim up --public --minutes 60      # push, build, stream; prints the URL
native-sim up --app <url> --public       # install an already-built simulator .app;
                                      # no source is pushed to the repo
native-sim status                        # session state + stream URL
native-sim down                          # cancel latest session; stream dies with it
native-sim down --all                    # cancel every run still in flight
native-sim doctor                        # check prerequisites
native-sim r2                            # one-time R2 setup for hosting builds
native-sim upload ./MyApp.app            # -> presigned URL for --app
```

Prerequisites: `gh` authenticated, Node 20+, an `expo` dependency in `package.json`.

## Never build locally

Building iOS on the developer's machine defeats the purpose of this tool. Use
`native-sim up --public`, add `--export` to pull the finished archive down, or `--app <url>`
to skip compiling entirely.

## How it works

1. Commits and pushes the app, creating the repo if needed.
2. Pushes `.github/workflows/native-sim.yml` **in a second push** (see Gotchas).
3. Dispatches the workflow with a session id and a per-session access key.
4. Runner: fingerprint → restore cached `.app` → boot simulator → `serve-sim` →
   auth gate → `cloudflared` → **publish URL** → build (only on cache miss) →
   install + launch → hold.
5. The URL is published as a **commit status**, the only GitHub surface readable
   while a job is still running. The CLI polls it and opens the browser.

## Expected timings

| | Cold | Warm cache |
|---|---|---|
| Stream URL | ~5 min | ~3 min |
| App on screen | ~33 min | ~7 min |

The native build is ~28 min. `@expo/fingerprint` keys the cached `.app`; it ignores
app JS, so JS-only changes hit the cache and `expo export:embed` refreshes the bundle
inside the cached binary. Native dependency or config-plugin changes force a rebuild.

## Gotchas

- **The first push to a brand-new empty repo is not scanned for workflows.** A workflow
  shipped in `gh repo create --push` never registers and every dispatch 404s. Push the
  app first, the workflow second, then poll `actions/workflows` to confirm.
- **`actionlint` does not catch delivery problems** — only file validity. To tell "bad
  YAML" from "bad delivery", push a byte-identical copy under a new name and see if it
  registers.
- **GitHub Actions expressions have no arithmetic.** `${{ fromJSON(x) + 20 }}` fails at
  runtime. Use fixed values plus per-step `timeout-minutes`.
- **Never rewrite `Host` in a proxy in front of serve-sim.** It derives the URLs it hands
  the browser from the request headers, so a rewritten Host makes the page open its
  control WebSocket against the *viewer's* `127.0.0.1:3200` — surfacing as
  `control socket connect timeout` and endless "connecting". Forward the public Host
  plus `X-Forwarded-Proto`/`X-Forwarded-Host` instead.
- **Runners must be arm64** (`macos-26`, `macos-15`). `serve-sim` ships arm64-only
  binaries; `-large`/`-intel` labels are x64 and will not work.
- **Job logs are unavailable until the job completes.** Track progress via the steps API.

See [REFERENCE.md](REFERENCE.md) for architecture, measured data, and troubleshooting, and
`docs/how-the-connection-works.md` for how the stream reaches the browser and what keeps
the runner alive, and `docs/prebuilt-app-flow.md` for running a prebuilt app from a repo
that contains no source.
