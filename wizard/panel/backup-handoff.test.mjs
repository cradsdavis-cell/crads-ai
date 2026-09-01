// backup-handoff.test.mjs — GitHub backup lives in the box's OWN app.
//   node --test wizard/panel/backup-handoff.test.mjs
//
// History, because this file used to pin the opposite twice over. The own-brain
// (GitHub backup) flow was originally reachable only from the claim page, so
// 2026-07-30 added a /go/connect?box=<slug> hop that carried the box across to
// it, and these tests pinned that hop. 2026-08-05 fixed the real problem — "the
// button connects GitHub, instead of sending you somewhere to do it" — by
// putting the card in the member app. 2026-09-01 deleted the invite page and
// its server entirely (nobody can be invited TO a box), so the /go/connect
// route itself is gone: there is no invite page left to route to.
//
// What these tests guard now: the backup card is IN the app, /go/connect stays
// dead, and nothing sends a member hunting for a surface that no longer exists.
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

test('/go/connect is GONE: 404 even for a caller still wiring the old options', async () => {
  const s = await listen({ connectUrl: 'http://127.0.0.1:9/connect', doorUrl: 'http://127.0.0.1:9/door' });
  try {
    for (const q of ['', '?box=jane01-box']) {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/go/connect${q}`, { redirect: 'manual' });
      assert.equal(r.status, 404, 'the invite hop must stay dead, not resurrect from an option');
    }
  } finally { s.close(); }
});

test('no member surface sends anyone to the invite page for their backup (or anything else)', () => {
  const shell = read('member.html');
  assert.ok(!/go\/connect/.test(shell.replace(/^\s*\/\/.*$/gm, '')),
    'member.html: still links the invite page, which no longer exists');
});

test('the backup flow is present in the box\'s own app', () => {
  const app = read('member.html');
  assert.match(app, /seatBackupGh/, 'the in-app Backup card is the permanent home of this flow');
  assert.match(app, /Backup/, 'the seat must still name the card');
  assert.match(app, /\/own-brain\/start/, 'and it drives the own-brain routes in place');
});
