#!/usr/bin/env node
// gh-device-login.mjs — sign this box in to GitHub with NO prompts and no menus.
//
// WHY THIS EXISTS. `connect-github` used to call a bare `gh auth login`, which
// opens the GitHub CLI's interactive picker: "Authenticate Git with your GitHub
// credentials?", then "How would you like to authenticate GitHub CLI?" with an
// arrow-key menu. Sam, looking at it on a rock: "pretty intimidating for a
// non-technical user". It is, and this product exists so that people who have
// never used a terminal can run their own assistant.
//
// So the box does the device flow itself and prints two lines: a URL and a code.
// Same flow the desktop app runs (wizard/panel/github-device-flow.mjs), same
// registered OAuth App, so whichever route someone takes they see the same
// short code and the account lands in the same place.
//
// The token is written by `gh auth login --with-token` over stdin, so it never
// appears in argv or in this script's output.
//
// Usage:  node gh-device-login.mjs            (no-op when already signed in)
//         node gh-device-login.mjs --force    (sign in again anyway)

import { execFileSync, spawnSync } from 'node:child_process';

// Device-flow client ids are public identifiers by design (there is no secret in
// this grant type). Kept in step with the app's copy.
const CLIENT_ID = process.env.AIOS_GH_CLIENT_ID || 'Ov23lixA2dRqRtv5hfnm';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GH_CONFIG_DIR = process.env.GH_CONFIG_DIR || '/state/.kernel/gh';
// 'repo' to create the private brain repo; 'read:org' because `gh auth login
// --with-token` REFUSES a token without it ("missing required scope
// 'read:org'"). Keep in step with GH_SCOPES in wizard/panel/org-github-routes.mjs.
const SCOPES = 'repo read:org';

// GH_TOKEN / GITHUB_TOKEN must be OUT of the environment, or `gh auth login
// --with-token` refuses: "The value of the GH_TOKEN environment variable is
// being used for authentication. To have GitHub CLI store credentials instead,
// first clear the value from the environment." This box's login shell can carry
// either (the factory verbs export exactly those names), so a sign-in that
// worked by hand would fail when driven, and the other way round.
const env = { ...process.env, GH_CONFIG_DIR };
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
const say = (s = '') => process.stdout.write(s + '\n');
const gh = (args, opts = {}) => spawnSync('gh', args, { encoding: 'utf8', env, ...opts });

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return r.json();
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  if (!process.argv.includes('--force') && gh(['auth', 'status']).status === 0) {
    const who = gh(['api', 'user', '-q', '.login']).stdout.trim();
    say(`Already signed in to GitHub${who ? ` as ${who}` : ''}.`);
    return 0;
  }

  let code;
  try {
    code = await post(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPES });
  } catch (e) {
    say(`Could not reach GitHub just now (${e.message}). Check the connection and try again.`);
    return 1;
  }
  if (!code || !code.device_code || !code.user_code) {
    say('GitHub did not start the sign-in. Try again in a minute.');
    return 1;
  }

  say('');
  say('  1. On your phone or any browser, open:   ' + (code.verification_uri || 'https://github.com/login/device'));
  say('  2. Enter this code:                      ' + code.user_code);
  say('');
  say('Waiting for you to approve it. Nothing else to do here.');

  const started = Date.now();
  let interval = Math.max(1, Number(code.interval) || 5);
  const limitMs = Math.min(Number(code.expires_in) || 900, 900) * 1000;
  // Date.now() is fine here: this runs on the box, not in a workflow script.
  while (Date.now() - started < limitMs) {
    await sleep(interval);
    let grant;
    try {
      grant = await post(TOKEN_URL, {
        client_id: CLIENT_ID, device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch { continue; }                       // a blip is not an answer
    if (grant.access_token) {
      // stdin, never argv: a token in argv is in every process list on the box.
      const login = gh(['auth', 'login', '--with-token', '--hostname', 'github.com'], { input: grant.access_token + '\n' });
      if (login.status !== 0) {
        say('GitHub approved the sign-in but this box could not store it.');
        say(String(login.stderr || '').split('\n')[0]);
        return 1;
      }
      gh(['auth', 'setup-git']);
      // KEEP THE REFRESH HALF (2026-08-10). GitHub's answer carries expires_in
      // and refresh_token when the app has token expiration on; throwing them
      // away meant every connected mineral's GitHub died in ~8 hours with no
      // path back but a human at a terminal. gh-token-refresh spends it hourly.
      try {
        const { saveGrant } = await import('./gh-token-refresh.mjs');
        if (saveGrant(grant, { dir: GH_CONFIG_DIR })) say('This sign-in renews itself; you will not have to do this again.');
      } catch { /* refresher absent on an older image: the login still worked */ }
      const who = gh(['api', 'user', '-q', '.login']).stdout.trim();
      say('');
      say(`Signed in as ${who || 'your GitHub account'}.`);
      return 0;
    }
    if (grant.error === 'authorization_pending') continue;
    if (grant.error === 'slow_down') { interval += 5; continue; }
    if (grant.error === 'access_denied') { say(''); say('The sign-in was declined on github.com. Nothing changed.'); return 1; }
    if (grant.error === 'expired_token') break;
  }
  say('');
  say('That code expired before it was approved. Run this again for a fresh one.');
  return 1;
}

// Only when run directly, so a future importer gets the functions and no exit.
if (process.argv[1] && process.argv[1].endsWith('gh-device-login.mjs')) {
  main().then((c) => process.exit(c)).catch((e) => { say(String(e && e.message ? e.message : e)); process.exit(1); });
}

export { CLIENT_ID, main };
