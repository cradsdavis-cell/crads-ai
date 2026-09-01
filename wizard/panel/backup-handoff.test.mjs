// backup-handoff.test.mjs — GitHub backup lives in the box's OWN app.
//   node --test wizard/panel/backup-handoff.test.mjs
//
// History, because this file used to pin the opposite. The own-brain (GitHub
// backup) flow was originally reachable only from the claim page, so 2026-07-30
// added a /go/connect?box=<slug> hop that carried the box across to it, and
// these tests pinned that hop. 2026-08-05 fixed the real problem — "the button
// connects GitHub, instead of sending you somewhere to do it" — by putting the
// card in the member app. 2026-08-09 (Sam: the invite page is the invite claim
// and nothing else) deleted the own-brain fold from member-connect entirely.
//
// So the hop now has no destination, and what these tests must guard is the new
// arrangement: the backup card is IN the app, nothing sends a member to the
// invite page to find it, and /go/connect remains an honest route to the invite
// page itself for the two things that genuinely live there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

const listen = (opts) => new Promise((resolve) => {
  const srv = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html></html>', ...opts });
  srv.on('listening', () => resolve(srv));
});

test('/go/connect routes to the invite page, carrying no fragment for a deleted fold', async () => {
  const s = await listen({ connectUrl: 'http://127.0.0.1:9/connect', doorUrl: 'http://127.0.0.1:9/door' });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/go/connect?box=jane01-box`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.equal(loc, 'http://127.0.0.1:9/connect');
    assert.ok(!loc.includes('#ownbrain'), 'the own-brain fold is gone; pointing at it is a link to nowhere');
  } finally { s.close(); }
});

test('/go/connect falls back to the door rather than 404ing (no cul-de-sac)', async () => {
  const s = await listen({ connectUrl: '', doorUrl: 'http://127.0.0.1:9/door' });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/go/connect`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'http://127.0.0.1:9/door');
  } finally { s.close(); }
});

test('with neither target, it says what to do instead of dead-ending', async () => {
  const s = await listen({ connectUrl: '', doorUrl: '' });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/go/connect`, { redirect: 'manual' });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /reopen the Crads-AI app/i);
  } finally { s.close(); }
});

test('no member surface sends anyone to the invite page to find their backup', () => {
  for (const f of ['member.html', 'member-console.html']) {
    const s = read(f);
    assert.ok(!/go\/connect\?box=/.test(s),
      `${f}: still hops to the invite page for backup, which no longer hosts that flow`);
  }
});

test('the backup flow is present in the box\'s own app', () => {
  const app = read('member.html');
  assert.match(app, /seatBackupGh/, 'the in-app Backup card is the permanent home of this flow');
  assert.match(app, /Backup/, 'the seat must still name the card');
});

test('the invite page keeps no trace of the own-brain flow', () => {
  const c = read('member-connect.html');
  for (const gone of ['obFold', 'obStart', 'ownBrainCard', '#ownbrain']) {
    assert.ok(!c.includes(gone), `member-connect still carries ${gone}`);
  }
});
