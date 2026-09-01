// transfer-consent.test.mjs — the member's own sign-in is what accepts a transfer.
// Run: node --test wizard/panel/transfer-consent.test.mjs
//
// Harriet's audit, 2026-08-19, point 3: accepting a transfer-to-org was a script
// on the box, runnable by anyone on the box (a granted support session included),
// and the org's completer could not tell. These pin the new shape end to end on
// the app side: the route reads the invitation FROM THE BOX (never the page),
// signs the member in nonce-bound to the anchoring rock, records consent at the
// directory and hands back only a receipt; the box verb refuses without one;
// the org completer asks the directory before it flips owner and refuses when
// the record is missing or for another invitation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPanelServer, VERBS, MEMBER_VERBS } from './panel-server.mjs';

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const consent = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/transfer-consent`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const bridge = { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} };
const boxState = (inv, own) => async () => ({ stdout: 'TRANSFER_STATE ' + JSON.stringify({ inv, own }) + '\n' });

test('the box verb refuses to run without a receipt, and passes a well-formed one through', () => {
  assert.throws(() => MEMBER_VERBS['transfer-accept'].build({}), /needs your consent receipt/);
  assert.throws(() => MEMBER_VERBS['transfer-accept'].build({ receipt: 'nope' }), /needs your consent receipt/);
  assert.throws(() => MEMBER_VERBS['transfer-accept'].build({ receipt: '$(rm -rf /)' }), /needs your consent receipt/, 'only 32 hex chars ever reach the shell');
  const r = 'ab'.repeat(16);
  assert.match(MEMBER_VERBS['transfer-accept'].build({ receipt: r }).command, new RegExp(`bash "\\$S" /state ${r}$`));
});

test('/transfer-consent: invitation + rock come from the BOX, sign-in is nonce-bound to that rock, receipt comes back', async () => {
  let sent = null, nonceUsed = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    sent = { url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, receipt: 'c'.repeat(32) }) };
  };
  try {
    const s = await listen({
      edition: 'member', bridge, directoryUrl: 'https://dir.example',
      transferProbe: boxState({ invited: '2026-08-19', repo: 'ic/jane01-brain' }, { owner: 'member', anchor: 'acme-collab' }),
      handoverSignIn: async ({ nonce }) => { nonceUsed = nonce; return { ok: true, idToken: 'stub.id.token' }; },
    });
    try {
      // the page names a different box and a different org; both are ignored
      const r = await consent(s, { host: 'someone-elses-box', org: 'evil-rock' });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.receipt, 'c'.repeat(32));
      assert.equal(j.org, 'acme-collab', 'the rock is the one the BOX is anchored to');
      assert.equal(j.invited, '2026-08-19');
      assert.match(sent.url, /\/transfer-consent$/);
      assert.equal(sent.auth, 'Bearer stub.id.token');
      assert.deepEqual(sent.body, { org: 'acme-collab', slug: 'jane01', host: 'jane01-box', invited: '2026-08-19' });
      const { joinNonce } = await import('./member-connect.mjs');
      assert.equal(nonceUsed, joinNonce('acme-collab'), 'the token is committed to the anchoring rock, not replayable elsewhere');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('/transfer-consent: no invitation on the box, or no anchoring rock, is a 409 and nothing is signed or sent', async () => {
  let signed = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://dir.example')) throw new Error('must not be called'); return realFetch(url, init); };
  try {
    const none = await listen({ edition: 'member', bridge, directoryUrl: 'https://dir.example',
      transferProbe: boxState(null, { owner: 'member', anchor: 'acme-collab' }),
      handoverSignIn: async () => { signed++; return { ok: true, idToken: 'x' }; } });
    try {
      const r = await consent(none, { host: 'jane01-box' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /holds no transfer invitation/);
    } finally { none.close(); }
    const mountain = await listen({ edition: 'member', bridge, directoryUrl: 'https://dir.example',
      transferProbe: boxState({ invited: '2026-08-19' }, { owner: 'member', anchor: 'crads-ai' }),
      handoverSignIn: async () => { signed++; return { ok: true, idToken: 'x' }; } });
    try {
      const r = await consent(mountain, { host: 'jane01-box' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /not anchored to a rock/);
    } finally { mountain.close(); }
    assert.equal(signed, 0, 'no sign-in prompt for a transfer that cannot exist');
  } finally { globalThis.fetch = realFetch; }
});

test('/transfer-consent: a refused sign-in is a 401 and a directory refusal is surfaced, never a fake receipt', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    return { ok: false, status: 403, json: async () => ({ error: 'that mineral is held by a different account; sign in as its holder to consent' }) };
  };
  try {
    const probe = boxState({ invited: '2026-08-19' }, { owner: 'member', anchor: 'acme-collab' });
    const noSign = await listen({ edition: 'member', bridge, directoryUrl: 'https://dir.example', transferProbe: probe,
      handoverSignIn: async () => ({ ok: false, reason: 'closed the window' }) });
    try {
      const r = await consent(noSign, { host: 'jane01-box' });
      assert.equal(r.status, 401);
      assert.match((await r.json()).error, /your own sign-in is what makes this transfer yours to give/);
    } finally { noSign.close(); }
    const wrongHolder = await listen({ edition: 'member', bridge, directoryUrl: 'https://dir.example', transferProbe: probe,
      handoverSignIn: async () => ({ ok: true, idToken: 'stub' }) });
    try {
      const r = await consent(wrongHolder, { host: 'jane01-box' });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /held by a different account/);
    } finally { wrongHolder.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('/transfer-consent is a member-seat route only', async () => {
  const org = await listen({ edition: 'operator' });
  try { assert.equal((await consent(org, { host: 'x' })).status, 404); } finally { org.close(); }
});

test('the org completer asks the directory for consent and refuses without it, or with consent for another invitation', () => {
  const c = VERBS['transfer-org-complete'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  const consentAt = c.indexOf('transfer-consent?org=');
  const completeAt = c.indexOf('node orchestrator/transfer-org-complete.mjs');
  assert.ok(consentAt > 0 && completeAt > consentAt, 'consent is read from the directory BEFORE the completer runs');
  assert.match(c, /Bearer \$OTOK/, 'read with the org pull token');
  assert.match(c, /has not consented to this transfer with their own sign-in/, 'no record, no flip');
  assert.match(c, /\[ "\$CDATE" = "\$PD" \] \|\| \{ echo "REFUSED: the consent on record is for a different invitation/, 'consent binds to the invitation staged on the row');
  assert.match(c, /transfer-consent-consume/, 'a consent serves one transfer and is then consumed');
  assert.ok(c.indexOf('transfer-consent-consume') > c.indexOf('owner: "org"'), 'consumed only after the flip actually happened');
});
