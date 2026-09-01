// transfer-consent.test.mjs — what Harriet's audit left behind after the face
// collapse (2026-09-01).
// Run: node --test wizard/panel/transfer-consent.test.mjs
//
// Harriet's audit, 2026-08-19, point 3: accepting a transfer-to-org was a script
// on the box, runnable by anyone on the box, and the org's completer could not
// tell. The consent flow rode the central directory, and the directory is
// gone: POST /transfer-consent is deleted with the rest of the hosted routes,
// so nothing can mint a receipt any more. What survives, and stays pinned, is
// the fail-closed half: the box verb still refuses to run without a receipt
// (so the dead flow cannot be bypassed by calling the verb bare), and the org
// completer builder still refuses without a directory record. Both survive as
// exported builders until the machinery is deleted.
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

test('/transfer-consent is RETIRED: the route answers 404 on the one panel server', async () => {
  // The three behavioural tests that lived here (nonce-bound sign-in, the
  // box-read invitation, the 409/401 refusals) drove a route that recorded
  // consent at the directory. No directory, no route: the strongest remaining
  // truth is that it stays gone, so no page can be built against it again.
  const s = await listen({ bridge });
  try {
    const r = await consent(s, { host: 'jane01-box' });
    assert.equal(r.status, 404, '/transfer-consent must stay gone');
  } finally { s.closeAllConnections?.(); s.close(); }
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
