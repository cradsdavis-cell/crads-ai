#!/usr/bin/env node
// mcp-refresh.mjs: keep connections alive without asking the member again.
//
// The whole promise of doing OAuth ourselves is that a member signs in ONCE. That
// only holds if something renews the access token before it expires, on the box,
// unattended. This is that something: a cadence job.
//
// It refreshes anything inside the window, leaves everything else alone, and is
// deliberately conservative about failure. A refresh that fails is reported, not
// hidden and not retried into a rate limit; the connection keeps working until
// the token actually expires, and the member is only told when it truly needs
// them (which is what the decay ping reads).
//
//   node mcp-refresh.mjs <state-dir> [--window-min 30]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { discover, refresh, tokenRecord } from './mcp-oauth-lib.mjs';

const stateDir = path.resolve(process.argv[2] || '/state');
const wi = process.argv.indexOf('--window-min');
const WINDOW_MS = (wi > -1 ? Number(process.argv[wi + 1]) : 30) * 60 * 1000;
const OAUTH_F = path.join(stateDir, '.kernel', 'mcp-oauth.json');
const TOKEN_TOOL = path.join(import.meta.dirname, 'mcp-token.mjs');

const rd = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

const store = rd(OAUTH_F, {});
const now = Date.now();
const done = [], failed = [], skipped = [];

for (const [name, v] of Object.entries(store)) {
  // No refresh token means nothing to do: the member re-signs in when it lapses,
  // and the row already warns them it will. Not an error.
  if (!v.refresh_token) { skipped.push(`${name}: no refresh token`); continue; }
  // Unknown expiry is NOT treated as expired. Guessing would churn tokens on
  // working connections; a provider that says nothing gets left alone.
  if (v.expires_at == null) { skipped.push(`${name}: no expiry given`); continue; }
  if (v.expires_at - now > WINDOW_MS) { skipped.push(`${name}: not due`); continue; }

  try {
    const meta = v.token_endpoint
      ? { token_endpoint: v.token_endpoint }
      : await discover(fetch, v.url);
    const json = await refresh(fetch, meta, {
      refreshToken: v.refresh_token, clientId: v.client_id, clientSecret: v.client_secret, resource: v.url,
    });
    const rec = tokenRecord(json, Date.now());
    // Hand it to the ONE writer, so the header + the store can never disagree
    // about what this connection currently is.
    const payload = Buffer.from(JSON.stringify({
      name, url: v.url, token_endpoint: meta.token_endpoint, client_id: v.client_id, client_secret: v.client_secret,
      access_token: rec.access_token, refresh_token: rec.refresh_token, token_type: rec.token_type, expires_at: rec.expires_at,
    }), 'utf8').toString('base64');
    execFileSync('node', [TOKEN_TOOL, stateDir, 'set'], { input: payload, encoding: 'utf8' });
    done.push(name);
  } catch (e) {
    failed.push(`${name}: ${String(e.message || e).slice(0, 80)}`);
  }
}

process.stdout.write(JSON.stringify({
  ok: true, refreshed: done, failed, skipped,
  summary: `${done.length} refreshed, ${failed.length} failed, ${skipped.length} not due`,
}) + '\n');
process.exit(failed.length ? 1 : 0);
