// github-device-flow.mjs — GitHub device-flow sign-in for the member-owned brain
// (D58 P3, spec § 3). The member types a short code at github.com/login/device from
// ANY browser; the app polls for the grant. No client secret exists in this flow, so
// nothing here is confidential. Zero dependencies; fetcher/sleeper injectable.
//
// The OAuth App client id is registration-time config (BLOCKERS.md): pass it in, or
// set AIOS_GH_CLIENT_ID. Scope 'repo' is required to create the member's PRIVATE
// brain repo and register its deploy key.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

// The Crads-AI OAuth App (device flow enabled, registered 2026-07-24). Client ids for
// device-flow apps are public identifiers by design; env override supported.
const DEFAULT_CLIENT_ID = 'Ov23lixA2dRqRtv5hfnm';

export async function startDeviceFlow({ clientId = process.env.AIOS_GH_CLIENT_ID || DEFAULT_CLIENT_ID, scope = 'repo', fetcher = fetch, sleeper = wait, maxPolls = 450 } = {}) {
  if (!clientId) throw new Error('no GitHub client id configured (register the OAuth App; see BLOCKERS)');
  const res = await fetcher(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  const code = await res.json();
  if (!code || !code.device_code || !code.user_code) throw new Error('GitHub did not issue a device code');

  let interval = Math.max(1, Number(code.interval) || 5);

  async function poll() {
    for (let i = 0; i < maxPolls; i++) {
      await sleeper(interval);
      let body;
      try {
        const r = await fetcher(TOKEN_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId, device_code: code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }).toString(),
        });
        body = await r.json();
      } catch { body = null; }
      if (body && body.access_token) return { ok: true, token: body.access_token };
      const err = body && body.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { interval = Math.max(interval + 5, Number(body.interval) || interval + 5); continue; }
      if (err === 'expired_token') return { ok: false, reason: 'the sign-in code expired before it was used; start again' };
      if (err === 'access_denied') return { ok: false, reason: 'sign-in was denied or cancelled on GitHub' };
      // Any OTHER named OAuth error is permanent (bad client id, device flow disabled,
      // wrong grant): abort now instead of hammering GitHub for the full poll budget.
      if (err) return { ok: false, reason: `GitHub refused the sign-in (${err}); check the app's client id / device-flow setting` };
      // garbage/no-body responses: brief patience, then give up via maxPolls
    }
    return { ok: false, reason: 'sign-in timed out' };
  }

  return { userCode: code.user_code, verificationUri: code.verification_uri, expiresIn: code.expires_in, poll };
}
