// native-sim-template-version: 18
/**
 * native-sim auth gate.
 *
 * serve-sim ships no authentication, so exposing port 3200 through a public
 * tunnel would hand simulator control to anyone who guessed the URL. This is a
 * dependency-free reverse proxy that requires `?k=<token>` once, trades it for
 * an HttpOnly cookie, and forwards everything (including the MJPEG stream and
 * the control WebSocket) to serve-sim on localhost.
 *
 * It also multiplexes a second upstream onto the same tunnel: when
 * NATIVE_SIM_AGENT_PORT is set, `/agent-device/*` is routed to the local
 * `agent-device proxy` instead of serve-sim, so one URL carries both the
 * human-facing stream and the agent-facing control API.
 */
const http = require('node:http');
const net = require('node:net');

const TOKEN = process.env.NATIVE_SIM_GATE_TOKEN || '';
const TARGET_PORT = Number(process.env.NATIVE_SIM_TARGET_PORT || 3200);
// 0 disables the agent-device route entirely, so a session started without
// --agent exposes no extra surface at all.
const AGENT_PORT = Number(process.env.NATIVE_SIM_AGENT_PORT || 0);
const AGENT_PREFIX = '/agent-device';
const TARGET_HOST = '127.0.0.1';
const PORT = Number(process.env.NATIVE_SIM_GATE_PORT || 3199);
const COOKIE = 'native_sim_k';

if (!TOKEN) {
  console.error('NATIVE_SIM_GATE_TOKEN is required — refusing to proxy an unauthenticated simulator');
  process.exit(1);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/** agent-device authenticates with a bearer header; it never sends cookies. */
function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization || '').trim());
  return match ? match[1] : null;
}

function pathnameOf(req) {
  return new URL(req.url, 'http://localhost').pathname;
}

/** True when this request belongs to the agent-device proxy, not serve-sim. */
function isAgentRoute(req) {
  if (!AGENT_PORT) return false;
  const path = pathnameOf(req);
  return path === AGENT_PREFIX || path.startsWith(`${AGENT_PREFIX}/`);
}

/** Returns 'cookie' | 'bearer' | 'query' when authorised, or false. */
function authorize(req) {
  if (timingSafeEqual(cookieToken(req), TOKEN)) return 'cookie';
  if (timingSafeEqual(bearerToken(req), TOKEN)) return 'bearer';
  const url = new URL(req.url, 'http://localhost');
  if (timingSafeEqual(url.searchParams.get('k'), TOKEN)) return 'query';
  return false;
}

const DENIED = `<!doctype html><meta charset=utf-8><title>native-sim</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}code{background:#8882;padding:.15em .4em;border-radius:4px}</style>
<h1>🔒 native-sim</h1>
<p>This simulator stream needs the access key from the link the CLI printed.</p>
<p>Ask whoever started the session for the full URL — the one ending in <code>?k=…</code>.</p>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__native-sim/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, target: TARGET_PORT, agent: AGENT_PORT || null }));
    return;
  }

  const auth = authorize(req);
  if (!auth) {
    // agent-device leaves /health unauthenticated for reachability probes; the
    // gate deliberately does not, so an unauthenticated request can never reach
    // either upstream. `connect proxy` carries --daemon-auth-token on every
    // request, including that probe, so it authenticates normally.
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DENIED);
    return;
  }

  const agent = isAgentRoute(req);

  // Trade the query token for a cookie so the key stops travelling in URLs
  // (and so the preview's own fetches and WebSocket upgrades carry it). Never
  // on the agent route: a 302 mid-RPC would break the client, which has no
  // cookie jar and already authenticates per request.
  if (auth === 'query' && !agent) {
    const url = new URL(req.url, 'http://localhost');
    url.searchParams.delete('k');
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
      location: url.pathname + url.search,
    });
    res.end();
    return;
  }

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: agent ? AGENT_PORT : TARGET_PORT,
      method: req.method,
      // The agent-device proxy serves these routes under /agent-device/* itself,
      // so the path is forwarded verbatim rather than stripped.
      path: req.url,
      // Do NOT rewrite Host. serve-sim derives the URLs it advertises to the
      // browser from these headers; pointing them at 127.0.0.1:3200 makes the
      // page open its control WebSocket against the *viewer's* loopback, which
      // fails as "control socket connect timeout". Forward the public origin so
      // the helper and WebSocket URLs stay same-origin and route back through
      // this gate.
      headers: {
        ...req.headers,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': req.headers.host,
      },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream error: ${err.message}`);
  });

  req.pipe(upstream);
});

// WebSockets carry simulator input, so the upgrade path has to be proxied too.
server.on('upgrade', (req, socket, head) => {
  if (!authorize(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const upstream = net.connect(isAgentRoute(req) ? AGENT_PORT : TARGET_PORT, TARGET_HOST, () => {
    const forwarded = {
      ...req.headers,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': req.headers.host,
    };
    const headers = Object.entries(forwarded)
      .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`native-sim gate on :${PORT} -> :${TARGET_PORT}${AGENT_PORT ? ` (agent-device -> :${AGENT_PORT})` : ''}`);
});
