// protocol.mjs — the crads-ai:// deep link (D58 P2.2, spec 2026-07-24 § 2).
// Two halves, both dependency-free and injectable for tests:
//   registerProtocolHandler(): make the OS hand crads-ai:// links to this exe.
//     Windows: HKCU registry keys (per-user, no admin). macOS: the CFBundleURLTypes
//     plist entry is a PACKAGING-time fact (wizard-app.yml bundle), so runtime is a
//     no-op there. Linux dev boxes: no-op.
//   extractBox(argv): when the OS launches (or re-launches) the app from a link,
//     the URL arrives as an argv entry.
// extractInvite (crads-ai://join/) retired 2026-09-01 with the self-host sweep:
// invitations-to-a-box cannot exist; an old join link just opens the app's door.
import { execFile } from 'node:child_process';

const SCHEME = 'crads-ai';

// crads-ai://box/<slug> — "open my box". The ready email needs a link that lands
// a member IN their box (2026-07-30: it had none at all, and simply told them to
// go find the app). Returns the slug, which app.mjs turns into the right surface.
export function extractBox(argv) {
  for (const a of argv || []) {
    const m = String(a || '').match(/^crads-ai:\/\/box\/([a-z0-9][a-z0-9-]{0,38}[a-z0-9])\/?$/i);
    if (m) return m[1].toLowerCase();
  }
  return '';
}

// crads-ai://join-community/<token> — a community's join link (commons
// usability overhaul, 2026-09-02). The token is the join bundle's base64 body
// re-encoded base64url, so the whole link survives chat apps and browsers.
// This returns the TOKEN, which app.mjs forwards to the Communities page as
// #sec=commons&join=<token>: pure data on a whitelisted charset. The page
// decodes it back into the bundle and PRE-FILLS the join field; nothing joins,
// runs, or is written from the link itself (the run=signin discipline). A
// percent-encoded arrival is tolerated; anything outside the charset is
// dropped rather than guessed at.
export function extractJoinToken(argv) {
  for (const a of argv || []) {
    let s = String(a || '');
    if (!/^crads-ai:\/\/join-community\//i.test(s)) continue;
    try { s = decodeURIComponent(s); } catch { /* keep the raw form */ }
    const m = s.match(/^crads-ai:\/\/join-community\/([A-Za-z0-9_-]{1,4096})\/?$/i);
    if (m) return m[1];
  }
  return '';
}

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (e, so) => (e ? rej(e) : res(so))));

export async function registerProtocolHandler({ execPath = process.execPath, platform = process.platform, runner = run } = {}) {
  if (platform === 'win32') {
    const base = `HKCU\\Software\\Classes\\${SCHEME}`;
    try {
      await runner('reg', ['add', base, '/ve', '/d', 'URL:Crads-AI', '/f']);
      await runner('reg', ['add', base, '/v', 'URL Protocol', '/d', '', '/f']);
      await runner('reg', ['add', `${base}\\shell\\open\\command`, '/ve', '/d', `"${execPath}" "%1"`, '/f']);
      return { done: true };
    } catch (e) { return { done: false, reason: String(e.message || e) }; }
  }
  if (platform === 'darwin') return { done: false, reason: 'macOS: CFBundleURLTypes is set at packaging time (wizard-app.yml)' };
  return { done: false, reason: `no handler registration on ${platform}` };
}
