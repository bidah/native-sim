# How the connection works, and how it stays up

Streaming a live iOS Simulator out of a GitHub Actions runner sounds like it should be
impossible, because a GitHub-hosted runner has **no public IP and no inbound ports**.
Nothing on the internet can open a connection to it.

It works because nothing ever does. Three ordinary mechanisms are stacked:

1. A job that deliberately refuses to exit.
2. A tunnel dialed *outward* from inside the runner.
3. A screen-capture loop fast enough to look like video.

## 1. The job refuses to exit

A GitHub Actions job is just a shell script on a disposable VM. Normally it builds,
exits, and the VM is destroyed seconds later. The only reason the simulator stays
reachable is that the final step spends its whole life doing nothing:

```bash
END=$(( $(date +%s) + MINUTES * 60 ))
while [ "$(date +%s)" -lt "$END" ]; do
  curl -fsS -o /dev/null "http://127.0.0.1:$PREVIEW_PORT/healthz" || exit 1
  sleep 15
done
```

That loop **is** the hosting. While it spins, the VM exists, the simulator stays booted,
`serve-sim` keeps capturing, and the tunnel stays open. `--minutes N` sets `END`.

The health check matters: if `serve-sim` dies, the loop exits non-zero immediately
rather than holding a VM open for another 29 minutes streaming nothing.

## 2. The tunnel is dialed from the inside

`cloudflared`, running *inside* the job, makes an **outbound** connection to Cloudflare's
edge and holds it open. Cloudflare allocates a public hostname pointing at that
connection.

When your browser requests the hostname, Cloudflare does not connect to the runner —
it pushes the bytes back down the pipe the runner already opened. Same principle as
`ssh -R` or ngrok. No firewall rule, no port forward, no inbound anything.

```
YOUR BROWSER                    CLOUDFLARE EDGE
     │                                │
     │─ GET xxx.trycloudflare.com ───▶│
     │                                │  ┌── the runner dialed OUT to here
     │◀─────── frames ────────────────│──┘   and never hung up
                                      ▼
        ╔═══════════════════════════════════════════╗
        ║  macOS runner  (no inbound ports at all)  ║
        ║                                           ║
        ║   cloudflared                             ║
        ║       ▼                                   ║
        ║   :3199  gate.cjs      ← checks cookie    ║
        ║       ▼                                   ║
        ║   :3200  serve-sim   (preview + control)  ║
        ║       ▼                                   ║
        ║   :3100  capture helper                   ║
        ║       ▼                                   ║
        ║   IOSurface capture (Swift native addon)  ║
        ║       ▼                                   ║
        ║   iOS Simulator running your app          ║
        ╚═══════════════════════════════════════════╝
```

## 3. Video is one HTTP response that never ends

`serve-sim` reads the simulator's **IOSurface** — its GPU framebuffer — through a Swift
native addon. It needs no Xcode plugin and no instrumentation inside your app; it is
capturing the device's screen buffer directly.

Frames are JPEG-encoded and written as `multipart/x-mixed-replace` (MJPEG): a single
HTTP response that simply never completes, emitting a new frame part forever. That is
why it survives a plain HTTP tunnel — to Cloudflare it is an ordinary, very long
download.

WebRTC would be lower latency, but it wants a UDP path that a free quick tunnel cannot
provide without a TURN server, so native-sim pins `--codec mjpeg`.

## 4. Input travels the other way, over a WebSocket

Your taps, swipes, and keystrokes go browser → gate → `serve-sim` → `simctl` /
SimulatorKit, which injects a genuine touch event into the simulator.

This rides a WebSocket, which matters for the auth gate: an HTTP cookie check is not
enough, because the control channel arrives as an `Upgrade` request. `gate.cjs`
therefore re-checks authorisation in its `upgrade` handler and, when satisfied, opens a
raw TCP socket to `serve-sim` and pipes both directions.

Miss that, and you get a page that renders video but silently ignores every tap.

The gate must also **forward the public `Host`** rather than rewriting it to the upstream
address, plus `X-Forwarded-Proto: https` and `X-Forwarded-Host`. `serve-sim` builds the
URLs it hands the browser from those headers; rewriting `Host` to `127.0.0.1:3200` makes
the page dial the *viewer's* loopback, which presents as an endless "connecting" spinner
and `control socket connect timeout`. To check what a running instance is advertising:

```sh
curl -sL -c j -b j "$URL/?k=$KEY" | grep -oE 'wss://[^"]{0,60}'
```

It must show the tunnel hostname, never `127.0.0.1`.

## 4b. One tunnel, two consumers (`--agent`)

A quick tunnel points at exactly one local port, so anything else that needs to
be reachable has to share it. With `--agent`, the gate multiplexes on path:
`/agent-device/*` goes to `agent-device proxy` on 4310, everything else to
`serve-sim` on 3200. One URL, one token, two consumers — you watching in a
browser, and a coding agent on your machine driving the same simulator.

The proxy is the mechanism agent-device documents for exactly this shape: run it
"on the host that has access to simulators/devices", tunnel it, then point
another machine at it with `connect proxy`. The runner is that host, for
`--minutes N`.

Two details the gate had to learn:

- **Bearer auth.** agent-device authenticates per request with an
  `Authorization: Bearer` header and keeps no cookie jar. The gate's cookie
  handshake is invisible to it, so `authorize()` accepts the bearer token as a
  third credential alongside the cookie and `?k=`.
- **No redirects on that path.** The gate trades `?k=` for a cookie with a 302.
  Doing that mid-RPC would break the client, so the cookie handshake is skipped
  for `/agent-device/*`.

Without `--agent`, `NATIVE_SIM_AGENT_PORT` is empty and the route does not exist —
the session exposes no control surface beyond the stream it always had.

The XCTest runner that backs iOS snapshots is built during the session
(`agent-device prepare ios-runner`) rather than on first use, so the agent's
opening `snapshot` does not stall for minutes. It is cached under an exact key
that pins both the agent-device version and the Xcode version; agent-device
warns that a loose restore-key hands back a runner built for another toolchain,
which is worse than building one.

### The daemon must be told not to reap itself

`agent-device` runs a daemon behind the proxy, and it exits 300000ms after the
last command — `AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS`, with
`AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS` doing the same for the XCTest runner.
That default assumes a developer laptop, where reaping an idle daemon is
courtesy. Here it is fatal: the session spends its first minutes building and
installing, and the agent typically connects later, so the daemon is often gone
before the first command ever arrives.

Measured on the first live run: healthy at 13:28:56, `XCTest runner ready` at
13:32:36, dead by 13:37:44 — five minutes and eight seconds after the last
command, before the agent had issued one. **Health probes do not count as
activity**, so polling `/health` does not hold it open.

Both are set to `0` — "run until killed" — which is correct here and leaks
nothing: the hold loop *is* the session, and the VM is destroyed with it.

The failure is quiet, which is what makes it worth writing down. The proxy
survives the daemon and keeps answering `/health` with **HTTP 200** and a body
of `{"ok":false,"error":"fetch failed"}`, so `curl -f` scores it a success. The
hold-loop probe has to read the body.

## 5. Why every URL is single-use

A `cloudflared` quick tunnel hostname is random and belongs to that one process. When
the hold loop finishes, the job ends, the VM is destroyed, and the tunnel dies with it.
The URL stops resolving. **There is no stable address, and an old link can never be
revived** — every session gets a new one.

That is also why the CLI cannot print the URL up front: it is generated inside the
runner, minutes later. native-sim recovers it by having the runner publish it as a **commit
status**, the one GitHub surface readable while a job is still running (logs, artifacts,
and step summaries only appear after a job ends). The CLI polls
`repos/{owner}/{repo}/commits/{sha}/statuses` until it appears.

For a stable, predictable address you would swap the quick tunnel for a **named
Cloudflare tunnel** (needs an account and a domain) or **Tailscale** (needs a tailnet).
Both let you know the hostname *before* the run starts.

## 6. Ending a session

Because the hold loop *is* the hosting, stopping it is how you stop the stream. Cancelling
the run kills the loop, the VM is destroyed, and `cloudflared` dies with it — the URL
stops resolving within seconds, with no graceful drain.

```sh
native-sim down          # the most recent session
native-sim down --all    # every native-sim run still in flight
```

Doing nothing is also fine: the loop exits on its own at `--minutes`, and the job ends.
Nothing leaks. Cancelling only reclaims a runner sooner (5 concurrent macOS jobs on
Free/Pro/Team) — on a public repo the minutes are free either way.

## 7. What breaks, and why

| Symptom | Cause |
|---|---|
| "connecting…", `control socket connect timeout` | A proxy in front of `serve-sim` rewrote the `Host` header, so `serve-sim` advertised `wss://127.0.0.1:3200/helper/...` and the browser tried to open a WebSocket against **its own** loopback. Diagnosed by fetching the preview page through the tunnel and grepping for the advertised WebSocket URL. Fixed by forwarding the public `Host`. |
| Video works, taps do nothing | The WebSocket upgrade is not being proxied or authorised. |
| URL stops resolving | The hold loop ended and the VM was destroyed. Expected. |
| Device list empty, settings degraded | `serve-sim`'s metadata channel timing out over tunnel latency. Cosmetic; video and input are unaffected. |
| `agent-device` says "Remote daemon is unavailable"; `/agent-device/health` returns `{"ok":false,"error":"fetch failed"}` | The proxy is alive but its daemon was reaped after 5 minutes idle. Set `AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS=0`. Note `connect proxy` still reports success against a dead daemon — it allocates no lease until `open`, so the first real command is where it surfaces. |
| A template fix appears to have no effect on the runner | `scaffold()` refuses to overwrite a deployed template whose version is `>=` the bundled one, warning `differs from the bundled template` instead. Bump `native-sim-template-version`, or the edit never ships. |

## Port map

| Port | What |
|---|---|
| 3100 | `serve-sim` capture helper |
| 3200 | `serve-sim` preview UI, MJPEG stream, control WebSocket, `/healthz`, `/readyz` |
| 3199 | `gate.cjs` auth proxy — **the only port the tunnel points at** |
| 4310 | `agent-device proxy` — only with `--agent`; reached at `/agent-device/*` |

`cloudflared` is aimed at 3199, never 3200, so an unauthenticated request can never
reach `serve-sim`. `serve-sim` ships no authentication of its own; the gate is the only
thing standing between a leaked URL and full control of the simulator.
