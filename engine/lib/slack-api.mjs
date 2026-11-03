// slack-api.mjs: the Slack plumbing both Slack bridges share.
//
// Two programs talk to Slack over Socket Mode: the company agent on a team hub
// (engine/team/team-slack.mjs) and the owner's own DM with their assistant
// (engine/comms/slack-dm.mjs). Socket Mode means the box dials OUT over a
// WebSocket, so there is no public URL, no tunnel and nothing of ours in
// between. Node 24 has a global fetch and WebSocket, so this needs no
// dependencies. What lives here is only what the two must agree on: how a Web
// API call is made, what counts as a refused token, how Slack markup is made
// inert, how a long reply is split, and how one socket session acks and ends.
// Everything about WHO may talk to the bot stays in each bridge.

// Read per call, not at import, so a test (or a box behind a proxy) can point
// either bridge at a fake Slack by setting SLACK_API_BASE before it starts.
const apiBase = () => String(process.env.SLACK_API_BASE || 'https://slack.com/api').replace(/\/+$/, '');

export async function slackCall(method, token, body, { fetcher = fetch } = {}) {
  const r = await fetcher(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body || {}),
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!j) throw new Error(`Slack did not answer ${method} (HTTP ${r.status})`);
  return j;
}

// The errors that mean "this token will not work until somebody fixes it".
// Retrying them fast only burns requests (the Telegram bridge learned this as
// trap 71: 1,377 refusals in 47 seconds), so callers back off and re-read the
// token files instead.
const REFUSED = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'not_allowed_token_type', 'missing_scope']);
export const isSlackTokenRefused = (res) => res?.ok === false && REFUSED.has(res.error);

// Slack treats <, > and & as markup (<!channel>, <!here>, <https://x|label>).
// Nothing the model or the brain says may become a ping or a disguised link.
export const slackEscape = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Slack accepts long messages but renders anything past ~4,000 characters badly;
// split on a line break where one is near.
export function chunks(text, n = 3800) {
  const out = []; let rest = String(text);
  while (rest.length > n) { let cut = rest.lastIndexOf('\n', n); if (cut < n / 2) cut = n; out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, ''); }
  if (rest) out.push(rest);
  return out;
}

// One Socket Mode session on an already-opened `url` (apps.connections.open).
// Every envelope is acked FIRST, before anything looks at it: an envelope Slack
// does not hear back about within a few seconds is delivered again, and a slow
// handler must not turn into a duplicate turn. `hello` and `disconnect` are the
// session's own business; everything else goes to onEnvelope. Resolves (never
// rejects) when the socket ends, saying why, and the caller decides how long to
// wait before opening the next one. Slack sends `disconnect` routinely (about
// every few hours, reason `refresh_requested`), so ending is normal.
export function socketSession({ url, WS = globalThis.WebSocket, onEnvelope, onHello = () => {} }) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WS(url); } catch (e) { resolve({ error: String((e && e.message) || e) }); return; }
    let done = false;
    const finish = (why) => { if (done) return; done = true; try { ws.close(); } catch { /* already closed */ } resolve(why); };
    ws.onmessage = (m) => {
      let env; try { env = JSON.parse(String(m.data)); } catch { return; }
      if (env.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch { /* the close handler ends the session */ } }
      if (env.type === 'hello') { onHello(env); return; }
      if (env.type === 'disconnect') { finish({ disconnect: env.reason || 'disconnect' }); return; }
      try { onEnvelope(env); } catch { /* one bad envelope never ends the session */ }
    };
    ws.onclose = () => finish({ closed: true });
    ws.onerror = () => finish({ error: 'socket error' });
  });
}
