#!/usr/bin/env node
// gh-token-refresh.mjs — keep this mineral's GitHub sign-in ALIVE (2026-08-10).
//
// WHY THIS EXISTS. connect-github runs the device flow and stores the access
// token with `gh auth login --with-token`. GitHub's answer to that flow also
// carries `expires_in` and a `refresh_token`, and the first cut threw both
// away. OAuth user tokens (gho_) expire — about 8 hours when the app has token
// expiration on — so EVERY rock's GitHub silently died within a day of being
// connected, with no path back but a human re-running connect-github on the
// box. Found live on test-org-4 at the T8 cert: adoption's channel repos never
// got created, and the dead token surfaced three layers later as "repository
// not found", then "Bad credentials".
//
// So: the login now saves the refresh half, and this script spends it. A
// refresh token is single-use — GitHub returns a NEW one each time — so the
// store is written before the old one is discarded, and a failed exchange
// leaves the existing file untouched for the next attempt.
//
//   node gh-token-refresh.mjs [--force]      (no-op while the token is fresh)
//
// Scheduler runs it hourly, guarded on the store existing. Nothing here can
// prompt: an unrefreshable sign-in prints one honest line naming connect-github.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const CLIENT_ID = process.env.AIOS_GH_CLIENT_ID || 'Ov23lixA2dRqRtv5hfnm';
const TOKEN_URL = process.env.AIOS_GH_TOKEN_URL || 'https://github.com/login/oauth/access_token';
const GH_CONFIG_DIR = process.env.GH_CONFIG_DIR || '/state/.kernel/gh';
export const storePath = (dir = GH_CONFIG_DIR) => join(dir, 'device-refresh.json');
// refresh a little early: a token that dies mid-adoption is the whole bug
const EARLY_MS = 30 * 60 * 1000;

const env = { ...process.env, GH_CONFIG_DIR };
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];

/** Persist what the device flow returned. Called by gh-device-login on success. */
export function saveGrant(grant, { dir = GH_CONFIG_DIR, nowMs = Date.now() } = {}) {
  if (!grant || !grant.refresh_token) return false;   // app has expiry off: nothing to keep
  const p = storePath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    refresh_token: String(grant.refresh_token),
    expires_at: nowMs + (Number(grant.expires_in) || 8 * 3600) * 1000,
    refresh_expires_at: nowMs + (Number(grant.refresh_token_expires_in) || 6 * 30 * 24 * 3600) * 1000,
    saved_at: nowMs,
  }, null, 2) + '\n', { mode: 0o600 });
  return true;
}

export async function refreshIfNeeded({
  dir = GH_CONFIG_DIR, force = false, nowMs = Date.now(),
  fetcher = fetch, gh = (args, opts) => spawnSync('gh', args, { encoding: 'utf8', env, ...opts }),
  log = (m) => console.log(`[gh-token-refresh] ${m}`),
} = {}) {
  const p = storePath(dir);
  if (!existsSync(p)) return { skipped: 'no refresh store (sign-in predates this, or the app has token expiry off)' };
  let st;
  try { st = JSON.parse(readFileSync(p, 'utf8')); } catch { return { skipped: 'unreadable refresh store' }; }
  if (!st.refresh_token) return { skipped: 'no refresh token stored' };
  if (st.refresh_expires_at && nowMs > st.refresh_expires_at) {
    log('the refresh token itself has expired; run connect-github on this mineral once to re-authorize');
    return { expired: true };
  }
  if (!force && st.expires_at && nowMs < st.expires_at - EARLY_MS) {
    return { fresh: true, minutes: Math.round((st.expires_at - nowMs) / 60000) };
  }

  let grant;
  try {
    const r = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: st.refresh_token }).toString(),
    });
    grant = await r.json();
  } catch (e) {
    log(`GitHub was not reachable (${String(e.message || e).slice(0, 60)}); the stored refresh token is untouched, retrying next hour`);
    return { offline: true };
  }
  if (!grant || !grant.access_token) {
    // A refused refresh is terminal for THIS store, but never destroys it: a
    // GitHub-side blip must not cost the mineral its only way back.
    log(`GitHub refused the refresh (${(grant && grant.error) || 'no token returned'}); run connect-github on this mineral once to re-authorize`);
    return { refused: true, error: (grant && grant.error) || 'unknown' };
  }
  // PERSIST THE ROTATED TOKEN FIRST (2026-08-20 audit). The exchange above has
  // already happened, so GitHub has ALREADY invalidated the refresh token we
  // sent and handed back a new one: refresh tokens are single-use. Saving after
  // `gh auth login` meant that a failure to store the ACCESS token threw the new
  // REFRESH token away with it, while the file kept the one GitHub had just
  // spent. Every later run then re-sent a dead token, hit the terminal refused
  // branch, and the mineral's GitHub was gone until a human re-ran
  // connect-github and typed a device code. There is no automatic way back: the
  // device flow needs a person. The file's own header already promised this
  // ordering ("the store is written before the old one is discarded"); the code
  // did the opposite.
  saveGrant({ refresh_token: grant.refresh_token || st.refresh_token, expires_in: grant.expires_in,
    refresh_token_expires_in: grant.refresh_token_expires_in }, { dir, nowMs });
  const login = gh(['auth', 'login', '--with-token', '--hostname', 'github.com'], { input: grant.access_token + '\n' });
  if (login.status !== 0) {
    // The way back is safe on disk, so this is recoverable: the next run has a
    // live refresh token and simply tries again. Say so, and exit non-zero, or
    // the run ledger records a broken hour as a good one.
    log('GitHub issued a fresh token and the rotation was saved, but this mineral could not store the access token: '
      + String(login.stderr || '').split('\n')[0] + ' (the next run retries with the saved token)');
    return { storeFailed: true };
  }
  log('GitHub sign-in refreshed (the mineral keeps working; nobody had to do anything)');
  return { refreshed: true };
}

if (process.argv[1] && process.argv[1].endsWith('gh-token-refresh.mjs')) {
  const r = await refreshIfNeeded({ force: process.argv.includes('--force') });
  if (r.fresh) console.log(`[gh-token-refresh] still fresh (${r.minutes} min left)`);
  // storeFailed counts as a failure: the hour did not do its job, and reporting
  // it as ok is how a dead mineral kept reading green (2026-08-20 audit).
  process.exit(r.refused || r.expired || r.storeFailed ? 1 : 0);
}
