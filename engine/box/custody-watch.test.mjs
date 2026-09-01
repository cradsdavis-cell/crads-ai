// custody-watch: the box tells its member when custody or access moves.
// Harriet's audit point 4 (2026-08-19): a structurally valid ownership flip made
// no sound. These pin that every custody-shaped change now lands in the
// member's log and, when Telegram is linked, in their outbox; and that a fresh
// box never false-alarms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, snapshot, describe } from './custody-watch.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const box = (own = {}, { telegram = true } = {}) => {
  const d = tmpDir('custody-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({
    owner: 'member', managed_by: 'org', anchor: 'acme-collab',
    holder: { kind: 'account', email: 'harriet@example.com' }, grants: [], ...own,
  }));
  if (telegram) { mkdirSync(join(d, 'secrets')); writeFileSync(join(d, 'secrets', 'telegram_chat_id'), '12345\n'); }
  return d;
};
const setOwn = (d, patch) => {
  const o = JSON.parse(readFileSync(join(d, 'ownership.json'), 'utf8'));
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ ...o, ...patch }));
};
const outbox = (d) => existsSync(join(d, '.kernel', 'outbox')) ? readdirSync(join(d, '.kernel', 'outbox')) : [];
const logLines = (d) => existsSync(join(d, 'custody-log.jsonl')) ? readFileSync(join(d, 'custody-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

test('first run seeds silently: a baseline line, no message', () => {
  const d = box();
  const r = run(d);
  assert.equal(r.seeded, true);
  assert.deepEqual(r.events, []);
  assert.deepEqual(outbox(d), [], 'a fresh box has nothing to report');
  assert.equal(logLines(d)[0].event, 'baseline');
});

test('an ownership flip to org is reported to the member, in words, with a Telegram message', () => {
  const d = box();
  run(d);
  setOwn(d, { owner: 'org', owner_slug: 'acme-collab' });
  const r = run(d, { now: new Date('2026-08-19T06:00:00Z') });
  assert.equal(r.events.length, 1);
  assert.match(r.events[0], /OWNERSHIP CHANGED: this mineral is now owned by your rock \(acme-collab\)/);
  assert.match(r.events[0], /If you did not accept a transfer in your app, tell Sam immediately/);
  const files = outbox(d);
  assert.equal(files.length, 1);
  const msg = JSON.parse(readFileSync(join(d, '.kernel', 'outbox', files[0]), 'utf8'));
  assert.equal(msg.chat_id, '12345');
  assert.match(msg.text, /Custody \/ access change/);
  assert.match(msg.text, /OWNERSHIP CHANGED/);
  const log = logLines(d);
  assert.equal(log.at(-1).owner, 'org');
  assert.match(log.at(-1).event, /OWNERSHIP CHANGED/);
  // and it does not repeat: the seen snapshot moved with the report
  assert.deepEqual(run(d).events, []);
});

test('a support grant and its end are both reported; expiry counts as an end', () => {
  const d = box();
  run(d);
  mkdirSync(join(d, 'support'));
  const exp = new Date(Date.now() + 3600e3).toISOString();
  writeFileSync(join(d, 'support', 'access.json'), JSON.stringify({ grant: { granted_at: new Date().toISOString(), expires_at: exp, hours: 1, key: 'ssh-ed25519 AAAA support' } }));
  let r = run(d);
  assert.match(r.events[0], /SUPPORT ACCESS GRANTED: Crads support can open this mineral until/);
  // expired window == no active grant
  writeFileSync(join(d, 'support', 'access.json'), JSON.stringify({ grant: { granted_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString(), hours: 1, key: 'x' } }));
  r = run(d);
  assert.match(r.events[0], /Support access ended/);
});

test('a transfer invitation arriving, an access grant, an eviction notice, an anchor move: each is one plain event', () => {
  const d = box();
  run(d);
  mkdirSync(join(d, 'org-inbox', 'transfer'), { recursive: true });
  writeFileSync(join(d, 'org-inbox', 'transfer', 'to-org.json'), JSON.stringify({ invited: '2026-08-19', repo: 'ic/harriet-brain' }));
  setOwn(d, { grants: [{ email: 'Mike@Example.com', role: 'admin', status: 'pending' }] });
  let r = run(d);
  assert.equal(r.events.length, 2);
  assert.ok(r.events.some((e) => /rock has asked to take custody.*invited 2026-08-19.*Nothing happens unless you accept/.test(e)));
  assert.ok(r.events.some((e) => /Access grant pending: mike@example.com \(admin\)/.test(e)));
  // eviction + anchor flip together (the real evict-apply shape)
  mkdirSync(join(d, 'org-inbox', 'evict'), { recursive: true });
  writeFileSync(join(d, 'org-inbox', 'evict', 'notice.json'), JSON.stringify({ org: 'acme-collab', reason: 'left', date: '2026-08-20' }));
  setOwn(d, { anchor: 'crads-ai' });
  r = run(d);
  assert.ok(r.events.some((e) => /acme-collab ended your membership/.test(e)));
  assert.ok(r.events.some((e) => /no longer anchored to acme-collab; it is anchored to Crads-AI/.test(e)));
});

test('no Telegram link: the log still records it, no outbox file, no crash', () => {
  const d = box({}, { telegram: false });
  run(d);
  setOwn(d, { owner: 'org' });
  const r = run(d);
  assert.equal(r.events.length, 1);
  assert.equal(r.sent, false);
  assert.deepEqual(outbox(d), []);
  assert.match(logLines(d).at(-1).event, /OWNERSHIP CHANGED/);
});

test('describe() is pure and quiet on identical snapshots', () => {
  const s = snapshot(box());
  assert.deepEqual(describe(s, s), []);
});
