// health-check.test.mjs: the mineral tells its member when it is unwell.
// Run: node --test engine/box/health-check.test.mjs
// The case: a member's off-box copy stopped on 12 Oct and nobody knew for two weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { check, run } from './health-check.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const NOW = Date.parse('2026-10-26T22:00:00Z');   // a Tuesday morning in Sydney, Monday in UTC
const ago = (h) => new Date(NOW - h * 3600000).toISOString();

function box({ origin = true, escrowed = true, telegram = true } = {}) {
  const s = tmpDir('health-');
  mkdirSync(path.join(s, '.git'), { recursive: true });
  writeFileSync(path.join(s, '.git', 'config'), origin ? '[remote "origin"]\n\turl = git@github.com:x/brain.git\n' : '[core]\n');
  mkdirSync(path.join(s, 'secrets'), { recursive: true });
  writeFileSync(path.join(s, 'secrets', 'backup_passphrase'), 'p\n');
  if (escrowed) writeFileSync(path.join(s, 'secrets', 'backup_passphrase.escrowed'), '');
  if (telegram) writeFileSync(path.join(s, 'secrets', 'telegram_chat_id'), '42\n');
  return s;
}
const healthy = [
  { ts: ago(18), job: 'backup', status: 'ok' },
  { ts: ago(18), job: 'brain-push', status: 'ok' },
  { ts: ago(20), job: 'skill /inbox-triage', skill: 'inbox-triage', status: 'ok' },
];

test('all well: ok, no problems', () => {
  const r = check(box(), { now: NOW, runs: healthy, disk: 40 });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('the 12 Oct shape: brain push failing is reported with its reason', () => {
  const runs = [...healthy.filter((r) => r.job !== 'brain-push'), { ts: ago(18), job: 'brain-push', status: 'fail', summary: 'push failed: GH001 Large files detected' }];
  const r = check(box(), { now: NOW, runs, disk: 83 });
  const ids = r.problems.map((p) => p.id);
  assert.deepEqual(ids.sort(), ['disk', 'offsite-failed']);
  assert.match(r.problems.find((p) => p.id === 'offsite-failed').text, /GH001/);
});

test('no backup in two days, no repo, unsaved passphrase, a failing job: each named', () => {
  const runs = [{ ts: ago(80), job: 'backup', status: 'ok' }, { ts: ago(30), job: 'x', skill: 'inbox-triage', status: 'fail' }, { ts: ago(6), job: 'x', skill: 'inbox-triage', status: 'fail' }];
  const ids = check(box({ origin: false, escrowed: false }), { now: NOW, runs, disk: 10 }).problems.map((p) => p.id);
  assert.deepEqual(ids, ['backup-missing', 'offsite-none', 'passphrase', 'job:inbox-triage']);
});

test('the member is told once per new problem, not every morning, and the report is written', () => {
  const s = box();
  const tue = new Date('2026-10-27T22:00:00'); tue.setDate(tue.getDate() + ((2 - tue.getDay() + 7) % 7));
  const at = (h) => new Date(tue.getTime() - h * 3600000).toISOString();
  const bad = [{ ts: at(1), job: 'backup', status: 'ok' }, { ts: at(1), job: 'brain-push', status: 'ok' }, { ts: at(2), job: 'x', skill: 'daily', status: 'fail' }];
  const first = run(s, { now: tue, runs: bad, disk: 40 });
  assert.equal(first.sent, true);
  const again = run(s, { now: new Date(tue.getTime() + 86400000), runs: bad, disk: 40 });
  assert.equal(again.sent, false, 'same problem next day: no repeat');
  assert.equal(readdirSync(path.join(s, '.kernel', 'outbox')).length, 1);
  assert.match(readFileSync(path.join(s, 'cockpit', 'health-report.md'), 'utf8'), /daily/);
});

test('Mondays send a summary even when all is well; no Telegram link still writes the report', () => {
  const mon = new Date('2026-10-26T22:00:00'); mon.setDate(mon.getDate() + ((1 - mon.getDay() + 7) % 7));
  assert.equal(run(box(), { now: mon, runs: healthy, disk: 40 }).sent, true);
  const quiet = box({ telegram: false });
  assert.equal(run(quiet, { now: mon, runs: healthy, disk: 40 }).sent, false);
  assert.equal(existsSync(path.join(quiet, 'cockpit', 'health-report.json')), true);
});
