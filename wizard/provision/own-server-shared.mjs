// own-server-shared.mjs: the pieces own-server.mjs (a server used for this
// alone) and adopt-host.mjs (a server the person's assistant already lives
// on) both need, kept here so neither module imports the other.

// Runs what it is given as root: directly when the login is root, through
// passwordless sudo otherwise. The script arrives on stdin, never in argv.
export const AS_ROOT_SCRIPT = 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi';

// Listeners that are not "reachable from outside": SSH (22), rpcbind (111,
// which some cloud images ship listening), loopback, link-local and Tailscale.
export const QUIET_PORTS = new Set(['22', '111']);
export function privateListener(host) {
  const h = String(host).replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return true;
  if (/^fe80:/.test(h) || /^fd7a:115c:a1e0:/.test(h)) return true;           // link-local, Tailscale v6
  const m = h.match(/^100\.(\d{1,3})\./);                                     // Tailscale CGNAT 100.64.0.0/10
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** The listening addresses (as `ss` prints them) reachable from outside, deduplicated, in order. */
export function publicListeners(listen) {
  const list = Array.isArray(listen) ? listen : String(listen || '').split(',');
  const out = [];
  for (const a of list.map((x) => String(x).trim()).filter(Boolean)) {
    const i = a.lastIndexOf(':');
    if (i < 0) continue;
    const host = a.slice(0, i); const port = a.slice(i + 1);
    if (!/^\d+$/.test(port) || QUIET_PORTS.has(port) || privateListener(host)) continue;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** The ports of publicListeners, sorted numerically. */
export function publicPorts(listen) {
  const ports = new Set(publicListeners(listen).map((a) => a.slice(a.lastIndexOf(':') + 1)));
  return [...ports].sort((x, y) => Number(x) - Number(y));
}
