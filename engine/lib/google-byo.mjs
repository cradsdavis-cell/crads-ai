// google-byo.mjs — the ONE place the shape of a member's Google accounts lives.
//
// Until 2026-09-14 a box carried exactly one Google account: server key
// `google`, one credential file, one dead marker, one probe ledger. Sam's
// ruling that day (multiple Google Workspaces per box): every account is its
// OWN connection row and its OWN workspace-mcp server, each signed in with its
// own key. The first account keeps the key `google` (every existing box, skill
// and tool name stays valid); every further account is `google-<slug>`, where
// the slug is the name the member gave it ("work" -> google-work), so the
// assistant's tool names read mcp__google-work__search_gmail_messages and a
// skill can say which account it means.
//
// Four consumers read this file so they cannot drift apart: mcp-connect.mjs
// (the rows + add-google), mcp-token.mjs (set-google), google-rekey-ping.mjs
// (the per-account probe) and vault/discover.mjs (the Secrets ledger). The
// app's google-connect-routes.mjs mirrors GOOGLE_KEY_RE by hand (it must not
// pull the engine tree into the app bundle); google-byo.test.mjs pins the two
// regexes equal.
import path from 'node:path';

// `google`, or `google-` + a slug of 1..20 chars: lowercase letters, digits,
// hyphens, starting alphanumeric. The whole key then fits NAME_RE (<= 32).
export const GOOGLE_KEY_RE = /^google(-[a-z0-9][a-z0-9-]{0,19})?$/;
export const PRIMARY_GOOGLE_KEY = 'google';

// What the member typed ("Work", "Acme Ltd") -> the slug half of the key.
// Empty when nothing usable survives, so the caller can say so.
export function googleSlug(label) {
  return String(label == null ? '' : label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '');
}

export const googleKeyFor = (label) => {
  const s = googleSlug(label);
  return s ? `google-${s}` : '';
};

// The slug half back out of a key ('' for the primary).
export const googleKeySlug = (key) => String(key || '').replace(/^google-?/, '');

// Per-account state files. The primary keeps the pre-2026-09-14 names, so a
// box that upgrades mid-life reads its own markers unchanged; every further
// account suffixes its slug.
export function googleStateFiles(stateDir, key) {
  const slug = googleKeySlug(key);
  const sfx = slug ? `.${slug}` : '';
  return {
    dead: path.join(stateDir, '.kernel', `google-key-dead${sfx}.json`),
    ledger: path.join(stateDir, '.kernel', `google-rekey-ping${sfx}.json`),
  };
}

export const GOOGLE_CREDS_DIR = (stateDir) => path.join(stateDir, '.kernel', 'google-creds');

// workspace-mcp's filename rule: URL-quoted email with @ . _ - kept bare
// (python urllib quote(safe="@._-")); encodeURIComponent additionally leaves
// ! * ' ( ) bare, so re-escape those to match byte-for-byte.
export const googleCredsFileName = (email) => encodeURIComponent(email).replace(/%40/g, '@')
  .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()) + '.json';

// Every BYO-Google entry in the oauth store, primary first, then by key.
export function googleEntries(store) {
  return Object.entries(store || {})
    .filter(([k, v]) => v && typeof v === 'object' && v.provider === 'google-byo' && GOOGLE_KEY_RE.test(k))
    .sort(([a], [b]) => (a === PRIMARY_GOOGLE_KEY ? -1 : b === PRIMARY_GOOGLE_KEY ? 1 : a.localeCompare(b)));
}
