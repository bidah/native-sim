# native-sim reference

Architecture, measured data, and troubleshooting. Everything here was observed on
real runs against `bidah/my-app` (Expo SDK 57, RN 0.86, Reanimated 4, `@expo/ui`).

## Why a commit status carries the URL

A `cloudflared` quick-tunnel URL is random and generated inside the runner, but
GitHub only exposes **logs, artifacts, and step summaries after a job ends** — useless
when the job *is* the 30-minute stream. Commit statuses are readable live:

```sh
gh api repos/$REPO/statuses/$SHA -f state=success \
  -f context="native-sim/$SESSION" -f target_url="$URL"
```

The CLI polls `repos/{owner}/{repo}/commits/{sha}/statuses`. Requires `statuses: write`.

## Step order, and why

```
deps → fingerprint → restore cache → boot sim → serve-sim → gate → tunnel
  → PUBLISH URL → build (miss only) → save cache → install + launch → hold
```

Publishing before the build is deliberate: the URL lands in ~3–5 min instead of ~33,
and the app installs into a simulator already on screen. The cost is CPU contention
during a cold build (see Troubleshooting) — which a warm cache eliminates.

## Build cache

Keyed on `@expo/fingerprint`, which hashes native inputs (dependencies, config plugins,
native dirs, native `app.json` fields) and **ignores application JS**.

```sh
npx @expo/fingerprint fingerprint:generate --platform ios   # → { hash, sources }
```

On a hit the build is skipped and `expo export:embed` rewrites `main.jsbundle` inside
the restored `.app`, so you get the old native shell with current JavaScript. Uses
`cache/restore` + explicit `cache/save` rather than `actions/cache`, because the latter
only saves in the post-job step — which does not run until the whole session ends.

Enabled by default. `--no-cache` forces a rebuild. Cache limits: 10 GB/repo, evicted
after 7 days unused.

## Measured timings (cold, `macos-26`, 3 cores)

| Step | Duration |
|---|---|
| setup + checkout + node + cache | 0.1 min |
| Install JS dependencies | 0.3 min |
| Boot simulator | 2.0 min |
| **Build and install the app** | **28.4 min** |
| Start serve-sim | 0.7 min |
| Auth gate + tunnel + publish | 0.1 min |
| Hold the stream open | as requested |

Cold: URL ~5 min, app ~33 min. Warm cache (measured): URL ~3 min, app running at **7 min**.

## Auth gate

`serve-sim` has no authentication, so `.github/native-sim/gate.cjs` fronts it: a
dependency-free reverse proxy that takes `?k=<token>` once, trades it for an HttpOnly
cookie, and enforces it on every request **and** on the control-WebSocket upgrade.
Verified: 403 without/with wrong token, 302+cookie with it, MJPEG streaming, WS upgrade
rejected unauthenticated, WS frames proxied bidirectionally when authorised, and the
public `Host` forwarded intact rather than rewritten to the upstream address.

Still a shareable bearer link — anyone given the full URL can drive the simulator.

**Never put the key in a commit status.** On a public repo those are readable with no
authentication at all (`curl api.github.com/repos/O/R/commits/$SHA/statuses`), so a
keyed `target_url` hands any passer-by a working link. The runner publishes the bare
tunnel URL; the CLI reattaches the key it generated. Logs and step summaries are 403
unauthenticated, and dispatch inputs are not exposed, but the same rule applies.

## Proxying serve-sim correctly

serve-sim derives the URLs it hands the browser from request headers. From its source:

```js
function m4($){ let Q = $.headers?.host; if(Q) return Q; ... }   // advertised host
function b5($){ return $.headers["x-forwarded-proto"] ... }
function GG($){ return b5($) === "https" ? "wss" : "ws" }        // advertised scheme
```

It also 403s the control socket when `new URL(origin).host !== headers.host`.

So a proxy in front of it **must forward `Host` untouched** and set
`X-Forwarded-Proto: https`. Rewriting `Host` to the upstream address makes the page
advertise `wss://127.0.0.1:3200/...`, so every viewer's browser dials its own loopback.
The symptom is intermittent — the client falls back, and a busy runner just widens the
window where you notice it — which makes it easy to misattribute to CPU or the tunnel.
`X-Forwarded-Host` is conventional but serve-sim never reads it.

### Diagnosing it

```sh
# 1. What does the page advertise? Must be the tunnel host, never 127.0.0.1.
curl -sL -c j -b j "$URL/?k=$KEY" | grep -oE 'wss://[^"]{0,70}'

# 2. Does the socket upgrade, carry both directions, and stay up?
#    Expect: 101, a BIN frame, PONG within ~200ms, no drop over 45s.
```

Verified on gate v3: advertised `wss://<tunnel-host>/helper/<udid>/ws`, 101 upgrade,
client PING → server PONG in 200 ms, held 45 s with no drop, and the preview's Activity
panel rendered live CPU/memory — which only flows over that socket.

## Stream settings

`GET <url>/api` on a live session reports what serve-sim actually applied:

```json
{ "streamUrl": ".../helper/<udid>/stream.mjpeg",
  "streamSettings": { "transport": "http", "codec": "h264",
                      "maxDimension": 900, "h264Fps": 30 } }
```

Two endpoints exist (from serve-sim's own router): `/stream.mjpeg` and `/stream.avcc`.
There is no `/stream`.

**H.264 is dead on GitHub runners.** `/stream.avcc` answers `200 application/octet-stream`
and then emits **zero bytes**, reproducibly, with or without a `device` param. `streamUrl`
in the state API is hardcoded to `.mjpeg`, so the browser uses MJPEG regardless and
`--codec h264` buys nothing. Default is `mjpeg`.

**`--video-fps` only sets `h264Fps`** — the unused path. MJPEG runs at `mjpegFps`, which
serve-sim defaults to **60**. Pass `--mjpeg-fps`/`--mjpeg-quality` to affect the real
stream.

Settings can be changed on a **live** session with `PATCH` (not PUT/POST, which return
`method_not_allowed`):

```sh
curl -X PATCH -H 'content-type: application/json' \
  -d '{"mjpegFps":30,"mjpegQuality":0.5,"maxDimension":700}' \
  "$URL/helper/$UDID/stream-settings"
```

Measured on an idle screen:

| settings | bandwidth | delivered fps |
|---|---|---|
| 60fps q0.7 900px (default) | 1.25 Mbit/s | ~4.5 |
| 30fps q0.6 900px | 1.05 Mbit/s | ~4.3 |
| 30fps q0.4 900px | 0.79 Mbit/s | ~4.5 |
| 30fps q0.5 700px | 0.66 Mbit/s | ~4.5 |
| 24fps q0.5 640px | 0.52 Mbit/s | ~4.0 |

**Read that table carefully.** Bandwidth falls 2.4x while delivered fps does not move,
because serve-sim emits frames on IOSurface *change* and the screen was idle — ~4.5 fps
is a static screen ticking over, not a ceiling. So these numbers rank bandwidth cost, not
perceived smoothness; judging smoothness needs an animating screen. Quality and
maxDimension are the effective levers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dispatch 404s, `actions/workflows` shows 0 | Workflow arrived in the first push to a new empty repo; GitHub never scanned it | Push app first, workflow second; poll until registered |
| `control socket connect timeout`, "connecting" churn | A proxy rewrote `Host`, so serve-sim advertised `wss://127.0.0.1:3200/...` and the browser dialled its own loopback | Forward the public `Host` + `X-Forwarded-Proto`/`-Host` (gate template v3) |
| Device list empty / settings panel degraded | `serve-sim` metadata channel timing out over tunnel latency | Cosmetic; video and input unaffected |
| Job queues forever | Bad `runs-on` label | Use `macos-26` or `macos-15` (arm64 only) |
| Stream URL dead | Quick tunnels die with the runner | Every session gets a new URL; use Tailscale/named tunnel for a stable one |

## Constraints

- GitHub kills hosted jobs at **6 hours**; 5 concurrent macOS jobs on Free/Pro/Team.
- Public repos: unlimited minutes, free. Private: macOS is **$0.062/min** and carries a
  **10× multiplier** against included minutes — one hour = 600 quota minutes or $3.72.
  A cold build alone is ~28 min ($1.74 / 280 quota min), which is why the build cache
  matters far more on private repos. Re-check rates; they change.
- MJPEG over HTTP, not WebRTC — a quick tunnel gives no UDP path without TURN.
- GitHub's Actions terms cover building/testing/publishing *that repo's* software.
  Occasional PR previews fit; a 24/7 public simulator host does not.

## Verified end to end

Cache hit measured on `bidah/my-app`: fingerprint stable across commits touching
`.github/`, `Build app` and `Save app build to cache` both `skipped`, `expo export:embed`
rewrote the JS bundle inside the restored `.app`, app running **7 min** after dispatch
versus ~33 cold.
