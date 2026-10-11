// same-origin.mjs — one cross-origin gate for every local server this app runs.
//
// THE HOLE THIS CLOSES (2026-08-20 audit). The panel, door and member-connect
// servers all bind loopback with no auth, no CSRF token and no Origin check, on
// the reasoning that only this machine can reach them. A browser breaks that
// reasoning: any page the operator merely visits can POST to 127.0.0.1 on a
// guessed port, and while it cannot READ the response, it does not need to.
// /term/open plus /term/input is blind command execution inside the org
// container that holds the Hetzner, Cloudflare and GitHub tokens, because
// terminal ids are the sequential t1, t2, t3. /pebble-build-request provisions
// and bills a real member box from a body of just a name and an email.
//
// The defence in the tree before this was a per-route `content-type:
// application/json` requirement, which does work (it forces a preflight no
// hostile page passes) but it existed on FOUR routes out of dozens, and every
// new verb had to remember it. This is the same defence applied once, at the
// door, where a new route cannot forget it.
//
// WHAT IS ALLOWED. Browsers send Sec-Fetch-Site on every request (Chrome 76+,
// Firefox 90+, Safari 16.4+) and Origin on every non-GET. Non-browser callers
// (the app's own node process, curl, the SSH relays) send neither, so they pass
// untouched: this gate refuses evidence of a foreign origin, it does not demand
// evidence of a local one. That keeps every programmatic caller working while
// closing the only path a web page has.
//
// Safe methods are exempt: a cross-origin GET can already read nothing.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// DNS REBINDING (teams security review, 2026-10-11). A hostile page can point its
// own name at 127.0.0.1; its requests then carry Origin evil.com:PORT AND Host
// evil.com:PORT, so the Origin check below sees "same origin" and lets it in, and
// GETs are readable by that page too (e.g. /team/teams). The defence is the Host
// header: this app only ever addresses itself by a loopback name, so any other
// Host is refused on EVERY method. A caller that sends no Host (raw sockets in
// tests) passes, as before.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function hostNotLocal(req) {
  const h = String(req.headers.host || '').trim().toLowerCase();
  if (!h) return false;
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return !LOOPBACK_HOSTS.has(name);
}

export function crossOriginBlocked(req) {
  if (hostNotLocal(req)) return true;
  if (SAFE.has(String(req.method || '').toUpperCase())) return false;

  // Sec-Fetch-Site is set by the browser and cannot be forged by page script.
  // same-origin: our own page. none: typed/bookmarked. same-site/cross-site:
  // another site drove this, which is exactly the case we refuse.
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return true;

  // Origin is the older signal and still the one Safari sends most reliably.
  // Absent means a non-browser caller. Present means a page, and it must be us.
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return false;
  if (origin === 'null') return true;                 // sandboxed iframe / data: document
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return true; }
  const self = String(req.headers.host || '').toLowerCase();
  if (host === self) return false;
  // The app addresses itself by both spellings on the same ephemeral port.
  const port = self.includes(':') ? self.slice(self.lastIndexOf(':') + 1) : '';
  return !(port && (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`));
}

// Writes the refusal. Kept here so all three servers say the same thing.
export function refuseCrossOrigin(res) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'refused: this request came from another site. The app talks to itself only.' }));
}
