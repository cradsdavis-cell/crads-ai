// anchor-wire-member.test.mjs — T7: the mineral side of anchor adoption.
// The app claims the staged bundle ONCE, the anchor-wire verb mints keys ON
// the mineral and prints only the PUBLIC halves, and the app relays them up.
// Stubs record what they received end to end (the handover lesson).
// Run: node --test wizard/panel/anchor-wire-member.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';

const jwt = (email) => 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s';
const KEY1 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial0000000000000000000000000';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial1111111111111111111111111';
const BUNDLE = { ok: true, org: 'acme', slug: 'jane01',
  bundle: { inbox_repo: 'acme-org/inbox-jane01', heartbeat_repo: 'acme-org/heartbeat-jane01', pull_token: 'pull-x', org_contact: { org: 'acme' } } };

// ---- verb builds: the command carries the contract ----------------------------
test('anchor-wire verb: bundle rides stdin, refusals + minting + PUBKEYS are in the script', () => {
  assert.throws(() => MEMBER_VERBS['anchor-wire'].build({ content_b64: 'not-base64!!' }));
  const b64 = Buffer.from(JSON.stringify(BUNDLE)).toString('base64');
  const v = MEMBER_VERBS['anchor-wire'].build({ content_b64: b64 });
  assert.equal(v.stdin, b64 + '\n', 'the bundle rides stdin, never argv');
  assert.match(v.command, /org-owned; its org wires it/, 'the org-owned refusal is in words');
  assert.match(v.command, /already carries a channel for/, 'the wrong-rock refusal is in words');
  assert.match(v.command, /ssh-keygen -q -t ed25519/, 'keys are minted ON the mineral');
  assert.match(v.command, /\[ -f \/state\/secrets\/org_inbox_deploy_key \] \|\|/, 'minting is idempotent');
  assert.match(v.command, /PUBKEYS /, 'only the public halves are printed');
  assert.ok(!/heartbeat_deploy_key"[^.]/.test(v.command.replace(/readFileSync\("\/state\/secrets\/[a-z_]+\.pub"/g, '')), 'no private key is ever read for output');
  assert.equal(MEMBER_VERBS['anchor-wire'].mutating, true);
});

test('anchor-pubkeys verb: org-scoped read, wired answers PUBKEYS, everything else NOTWIRED', () => {
  assert.throws(() => MEMBER_VERBS['anchor-pubkeys'].build({ org: 'Bad Org!' }));
  const v = MEMBER_VERBS['anchor-pubkeys'].build({ org: 'acme' });
  assert.match(v.command, /org-contact\.json/, 'wired-to-WHOM is checked, not just wired');
  assert.match(v.command, /NOTWIRED/, 'the miss is a named answer');
  assert.ok(!MEMBER_VERBS['anchor-pubkeys'].mutating, 'the probe never mutates');
});

// ---- the app flow -------------------------------------------------------------
function fakeBridge(answer, log) {
  return {
    targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }],
    stream: (host, command, { onStdout, stdin } = {}) => {
      const rec = { host, command, stdin: stdin || '' };
      log.push(rec);
      const ee = new EventEmitter();
      setImmediate(() => { const out = answer(rec); if (out) onStdout(out); ee.emit('close', 0); });
      return ee;
    },
    tty: () => {},
  };
}
function dirFetcher(calls, { staged = true } = {}) {
  return async (url, init = {}) => {
    const rec = { url: String(url), auth: (init.headers || {}).authorization || '', body: init.body ? JSON.parse(init.body) : {} };
    calls.push(rec);
    const u = String(url);
    if (u.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', box: 'jane01-box' }] }) };
    if (u.includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    if (u.includes('/anchor-wire-claim')) return staged
      ? { ok: true, status: 200, json: async () => BUNDLE }
      : { ok: false, status: 404, json: async () => ({ error: 'nothing staged' }) };
    if (u.includes('/anchor-pubkeys')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', edition: 'member', ...opts });
  s.on('listening', () => resolve(s));
});

test('unwired anchor: probe says NOTWIRED, the bundle is claimed once, the verb wires, the keys relay up', async () => {
  const calls = [];
  const verbs = [];
  const answer = (rec) => {
    if (rec.command.includes('NOTWIRED')) return 'NOTWIRED';
    if (rec.command.includes('PUBKEYS ')) return `OK: wired to acme\nPUBKEYS ${JSON.stringify({ inbox_pub: KEY1, heartbeat_pub: KEY2 })}`;
    return 'OK';
  };
  const s = await listen({
    bridge: fakeBridge(answer, verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls),
    accountToken: async () => ({ ok: true, idToken: jwt('jane@x.com'), email: 'jane@x.com' }),
  });
  try {
    await new Promise((r) => setTimeout(r, 250));
    const claim = calls.filter((c) => c.url.includes('/anchor-wire-claim'));
    assert.equal(claim.length, 1, 'the one-time bundle was claimed exactly once');
    assert.equal(claim[0].auth, `Bearer ${jwt('jane@x.com')}`, 'claimed as the signed-in member');
    const wire = verbs.find((v) => v.stdin && v.command.includes('org_inbox_deploy_key'));
    assert.ok(wire, 'the anchor-wire verb ran on the mineral');
    assert.equal(wire.host, 'jane01-box');
    assert.deepEqual(JSON.parse(Buffer.from(wire.stdin.trim(), 'base64').toString()), BUNDLE, 'the claimed bundle rode stdin verbatim');
    const post = calls.find((c) => c.url.endsWith('/anchor-pubkeys'));
    assert.ok(post, 'the public halves were relayed');
    assert.equal(post.body.inbox_pub, KEY1);
    assert.equal(post.body.heartbeat_pub, KEY2);
    assert.equal(post.body.box_host, 'jane01-box');
    // a second refresh must NOT re-claim: the flag holds
    await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls.filter((c) => c.url.includes('/anchor-wire-claim')).length, 1, 'no re-claim after success');
  } finally { s.close(); }
});

test('already-wired mineral: the probe answers PUBKEYS, no claim is spent, the relay still lands', async () => {
  const calls = [];
  const verbs = [];
  const answer = (rec) => {
    if (rec.command.includes('NOTWIRED')) return `PUBKEYS ${JSON.stringify({ inbox_pub: KEY1, heartbeat_pub: KEY2 })}`;
    return 'OK';
  };
  const s = await listen({
    bridge: fakeBridge(answer, verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls),
    accountToken: async () => ({ ok: true, idToken: jwt('jane@x.com'), email: 'jane@x.com' }),
  });
  try {
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(calls.filter((c) => c.url.includes('/anchor-wire-claim')).length, 0, 'the one-time claim was never spent');
    assert.ok(calls.find((c) => c.url.endsWith('/anchor-pubkeys')), 'the relay still lands (covers a lost post)');
  } finally { s.close(); }
});

test('T8 symmetry: an anchored leave chains leave-org on the mineral; a joined leave never does', async () => {
  const calls = [];
  const verbs = [];
  const answer = (rec) => (rec.command.includes('NOTWIRED') ? 'NOTWIRED' : 'OK');
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url) });
    const u = String(url);
    if (u.includes('/rock-tie-leave')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', box: 'jane01-box' },
      { org: 'club', role: 'member', status: 'active', slug: 'jane01', rel: 'joined' }] }) };
    if (u.includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    if (u.includes('/anchor-wire-claim')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const s = await listen({
    bridge: fakeBridge(answer, verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: fetcher,
    accountToken: async () => ({ ok: true, idToken: jwt('jane@x.com'), email: 'jane@x.com' }),
    communitySignIn: async () => ({ ok: true, idToken: jwt('jane@x.com') }),
  });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const post = (body) => fetch(`http://127.0.0.1:${s.address().port}/rock-leave`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const isLeaveOrg = (v) => v.command.includes('left.json');

    assert.equal((await post({ org: 'club', tie: 'joined' })).status, 200);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!verbs.find(isLeaveOrg), 'a JOINED leave never touches the mineral');

    assert.equal((await post({ org: 'acme', tie: 'anchored' })).status, 200);
    await new Promise((r) => setTimeout(r, 120));
    const chained = verbs.find(isLeaveOrg);
    assert.ok(chained, 'the anchored leave chained leave-org');
    assert.equal(chained.host, 'jane01-box', 'on the mineral the tie named');
  } finally { s.close(); }
});

test('nothing staged yet: a 404 claim leaves everything quiet for the rock to catch up', async () => {
  const calls = [];
  const verbs = [];
  const s = await listen({
    bridge: fakeBridge((rec) => (rec.command.includes('NOTWIRED') ? 'NOTWIRED' : 'OK'), verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls, { staged: false }),
    accountToken: async () => ({ ok: true, idToken: jwt('jane@x.com'), email: 'jane@x.com' }),
  });
  try {
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!calls.find((c) => c.url.endsWith('/anchor-pubkeys')), 'nothing was relayed');
    assert.ok(!verbs.find((v) => v.stdin && v.command.includes('org_inbox_deploy_key')), 'the wire verb never ran');
  } finally { s.close(); }
});

// ---- ownership: the account claims the minerals it can reach -----------------
test('mineral-claim verb: the claim rides stdin, the RULES live in the tested module not the shell', () => {
  assert.throws(() => MEMBER_VERBS['mineral-claim'].build({ content_b64: 'not-base64!!' }));
  const payload = Buffer.from(JSON.stringify({ account_id: 'acc_' + 'a'.repeat(24), email: 'sam@x.com' })).toString('base64');
  const v = MEMBER_VERBS['mineral-claim'].build({ content_b64: payload });
  assert.equal(v.stdin, payload + '\n', 'the account rides stdin, never argv');
  assert.match(v.command, /mineral-identity\.mjs/, 'the rules come from the tested module');
  assert.match(v.command, /claimOwner/, 'and it is the claim path, not a raw file write');
  assert.match(v.command, /predates the ownership model/, 'an older mineral gets a sentence, not a stack trace');
  assert.match(v.command, /MINERAL /, 'it reports back what it recorded');
  assert.equal(MEMBER_VERBS['mineral-claim'].mutating, true);
  assert.ok(!MEMBER_VERBS['mineral-identity'].mutating, 'the read never mutates');
});

test('the signed-in account claims each reachable mineral once, carrying its id AND its email', async () => {
  const calls = [];
  const verbs = [];
  const answer = (rec) => {
    if (rec.command.includes('NOTWIRED')) return 'NOTWIRED';
    if (rec.command.includes('claimOwner')) return 'MINERAL {"mineral_id":"min_' + 'a'.repeat(24) + '","holder":{"kind":"account","email":"jane@x.com"},"access":[],"tier":"pebble"}\nOK: this mineral is now recorded as yours';
    return 'OK';
  };
  // a token carrying the account id, the way the site mints it
  const tokenWithAid = 'h.' + Buffer.from(JSON.stringify({ email: 'jane@x.com', aid: 'acc_' + 'b'.repeat(24) })).toString('base64url') + '.s';
  const s = await listen({
    bridge: fakeBridge(answer, verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: dirFetcher(calls, { staged: false }),
    accountToken: async () => ({ ok: true, idToken: tokenWithAid, email: 'jane@x.com' }),
    communitySignIn: async () => ({ ok: true, idToken: tokenWithAid }),
  });
  try {
    await new Promise((r) => setTimeout(r, 250));
    const claims = verbs.filter((v) => v.command.includes('claimOwner'));
    assert.equal(claims.length, 1, 'claimed exactly once per run');
    assert.equal(claims[0].host, 'jane01-box');
    const sent = JSON.parse(Buffer.from(claims[0].stdin.trim(), 'base64').toString());
    assert.equal(sent.email, 'jane@x.com', 'the mineral records its holder in readable form');
    assert.equal(sent.account_id, 'acc_' + 'b'.repeat(24), 'keyed on the permanent account id from the token');
    await fetch(`http://127.0.0.1:${s.address().port}/rock-mine/refresh`, { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(verbs.filter((v) => v.command.includes('claimOwner')).length, 1, 'once per app run');
  } finally { s.close(); }
});

// ---- T8 UI half: the adopted row's honest card --------------------------------
test('adopted rows: badged, wiring-honest, and the Manage fold cannot touch their metal', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  // Re-pinned 2026-08-10 (third grill): the chips died with the card's
  // triple-stated health. "adopted" is one quiet word on the identity line, and
  // the wiring state is carried by the ONE status sentence stallRisk writes.
  // The identity line became a joined list when the Pebbles row started leading
  // with the mineral's own name (2026-08-16, docs/naming.md). Same one quiet
  // word, same line; it is pushed rather than concatenated now.
  // 'adopted' became 'anchored' in the run-6 vocabulary canon (anchored/joined
  // are the only tie words on the panel); the row still says so, same line.
  // R27 (panel iteration 2, 2026-08-23): every seated row now ends its
  // identity line with its tier, so the anchored word comes from tierLabel()
  // rather than a bare push; an adopted (attached) row still reads anchored.
  assert.match(html, /fcSub\.push\(esc\(tierLabel\(m\)\)\);/, 'an anchored row says so on its identity line');
  assert.match(html, /function tierLabel\(m, tie\)\{[\s\S]*?return 'anchored';/, 'and a seated row is anchored');
  assert.match(html, /wiring: their delivery channel is still being set up/, 'and an unwired one has its own honest sentence');
  assert.match(html, /var adopted = !!m\.attached;/, 'the shape gate reads the registry attached: field');
  assert.match(html, /nothing on this card can touch their metal or their devices/, 'the fold says why it is smaller');
  // Re-pinned 2026-08-10 (staged End flow): the enders left the Manage fold
  // for endFlow, which gates on the SAME adopted axis. The fold keeps exactly
  // one org-box-shaped control (the fresh invite/device link) behind the gate.
  const fold = html.slice(html.indexOf('var adopted = !!m.attached'), html.indexOf('fb.appendChild(mlog)'));
  // Re-pinned again 2026-08-10 (second grill): the fresh link is now gated on
  // OWNERSHIP too — a live member-owned pebble never gets a rock-minted device
  // link (the link is the proof); only the org-owned case and the never-
  // enrolled birth-invite case keep the button. Adopted stays excluded.
  assert.match(fold, /if \(!adopted && \(foldOrgOwned \|\| m\.status === 'invited'\)\) \{/,
    'the fresh link is gated on adopted AND ownership AND enrolment state');
  const at = fold.indexOf('invite-reissue');
  assert.ok(at > -1, 'invite-reissue still exists for the legal rows');
  // The End flow: one merged ender whose consequences respect the same axes.
  const ef = html.match(/function endFlow\(m, y, o\)\{[\s\S]*?\n  \}/)[0];
  assert.match(ef, /var choice = o\.adopted \? 'close' : null;/, 'adopted metal has one consequence: the tie closes');
  assert.match(ef, /if \(!o\.adopted && o\.orgOwned\) \{/, 'teardown is gated off adopted AND member-owned metal');
  assert.match(ef, /evict-member/, 'the close-the-tie consequence rides the evict machinery (notice delivered first)');
  assert.match(ef, /member-leave/, 'the keep-the-bridge consequence rides member-leave, reason riding along');
});

test('an unwired adopted row is never accused of going dark', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  const fn = html.slice(html.indexOf('function stallRisk'), html.indexOf('function stallRisk') + 1600);
  const guard = fn.indexOf('m.attached && !m.wired');
  // 79695ca added a phase: field between level: and reason:, so the needle
  // pins the reason only — still the VERDICT, not the comment above it (the
  // comment quotes "never checked in" with a double quote, not reason: ').
  const neverIn = fn.indexOf("reason: 'never checked in");
  assert.ok(guard > -1 && neverIn > -1 && guard < neverIn, 'the wiring case is judged BEFORE the never-checked-in verdict');
  assert.match(fn.slice(guard, neverIn), /level: 'watch'/, 'mid-flight machinery is watch, never AT RISK');
  assert.match(html, /wiring: their delivery channel is still being set up, so there is nothing to check in through yet/,
    'and the status sentence says WHY, rather than accusing them of never checking in');
  assert.match(fn, /just wired: waiting for their first check-in/, 'and a freshly wired row gets the same grace: the first check-in is ~90 min out by design');
});
