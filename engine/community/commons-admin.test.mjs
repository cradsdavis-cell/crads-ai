// commons-admin.test.mjs: the rock owner's commons config, roster ledger and
// bundle minting (self-host pivot, 2026-09-01).
//   node --test engine/community/commons-admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { parseBundle } from './commons-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ADMIN = path.join(HERE, 'commons-admin.mjs');

function rig() {
  const root = tmpDir('commons-admin-');
  const state = path.join(root, 'state');
  const brain = path.join(root, 'brain');
  const run = (cmd, { input, arg } = {}) => spawnSync(process.execPath,
    [ADMIN, state, brain, cmd, ...(arg ? [arg] : [])],
    { input: input === undefined ? '' : input, encoding: 'utf8', env: { ...process.env } });
  return { state, brain, run };
}
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

test('init writes the conf and the optional deploy key at 0600', (t) => {
  const { state, run } = rig();
  const r = run('init', { input: JSON.stringify({ url: 'https://github.com/hg/hg-commons.git', branch: 'main', org: 'harbour-guild', org_display: 'Harbour Guild', key: KEY }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: this rock's commons is https:\/\/github.com\/hg\/hg-commons.git \(branch main\), shared as "Harbour Guild" \(harbour-guild\)\. Deploy key saved\./);
  assert.equal(readFileSync(path.join(state, 'commons.conf'), 'utf8'),
    'URL=https://github.com/hg/hg-commons.git\nBRANCH=main\nORG=harbour-guild\nORG_DISPLAY=Harbour Guild\n');
  const keyPath = path.join(state, 'secrets', 'commons_deploy_key');
  assert.equal(readFileSync(keyPath, 'utf8'), KEY);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, 'key is private to the box user');
});

test('init refuses a bad url, a bad org and a non-key paste, loudly', () => {
  const { state, run } = rig();
  for (const [body, re] of [
    [{ url: 'file:///etc', org: 'hg-x' }, /url must be/],
    [{ url: 'ext::sh -c id', org: 'hg-x' }, /url must be/],
    [{ url: 'https://github.com/a/b', org: 'Bad Org' }, /community name/],
    [{ url: 'https://github.com/a/b', org: 'hg-x', branch: '-e' }, /branch/],
    [{ url: 'https://github.com/a/b', org: 'hg-x', key: 'ssh-ed25519 AAAA not-a-private-key' }, /deploy key/],
  ]) {
    const r = run('init', { input: JSON.stringify(body) });
    assert.equal(r.status, 1, JSON.stringify(body));
    assert.match(r.stdout, re);
  }
  const bad = run('init', { input: 'not json' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /JSON body/);
  assert.ok(!existsSync(path.join(state, 'commons.conf')), 'nothing written by any refusal');
});

test('status: unconfigured is a state, not an error; configured carries the facts', () => {
  const { run } = rig();
  let s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.equal(s.configured, false);
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x', org_display: 'HGX' }) });
  s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.equal(s.configured, true);
  assert.equal(s.org, 'hg-x');
  assert.equal(s.org_display, 'HGX');
  assert.equal(s.key_present, false);
  assert.deepEqual(s.roster, { active: 0, revoked: 0 });
  assert.equal(s.last_publish, null);
});

test('grant: records the roster row in the BRAIN (never the commons) and mints a working bundle', () => {
  const { brain, run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', branch: 'main', org: 'hg-x', org_display: 'HGX' }) });
  const r = run('grant', { input: JSON.stringify({ label: 'Astrid H', email: 'astrid@example.com', github: 'astrid-h' }) });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /OK: grant g-[a-z0-9]+ recorded for Astrid H/);
  assert.match(r.stdout, /out of band/);
  assert.match(r.stdout, /invite their GitHub account as a READ collaborator/, 'the host ACL step is named, every time');
  const bundleLine = r.stdout.split('\n').find((l) => l.startsWith('cradscommons1:'));
  const p = parseBundle(bundleLine);
  assert.equal(p.ok, true, p.error);
  assert.deepEqual(p.community, { org: 'hg-x', org_display: 'HGX', url: 'https://github.com/hg/c.git', urlKind: 'https', urlHost: 'github.com', branch: 'main' });
  const roster = JSON.parse(readFileSync(path.join(brain, 'registry', 'commons-roster.json'), 'utf8'));
  assert.equal(roster.grants.length, 1);
  assert.equal(roster.grants[0].label, 'Astrid H');
  assert.equal(roster.grants[0].status, 'active');
});

test('revoke: marks the ledger, tells the owner to cut host access, and the member keeps installs', () => {
  const { run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  const g = run('grant', { input: JSON.stringify({ label: 'Jem' }) });
  const id = g.stdout.match(/grant (g-[a-z0-9]+)/)[1];
  const r = run('revoke', { arg: id });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /marked revoked/);
  assert.match(r.stdout, /remove their read access on your git host/);
  assert.match(r.stdout, /already installed stays theirs/);
  const s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.deepEqual(s.roster, { active: 0, revoked: 1 });
  const again = run('revoke', { arg: id });
  assert.match(again.stdout, /already revoked/);
  assert.equal(run('revoke', { arg: 'g-nope0000' }).status, 1);
});

test('grant refusals: no label, bad email, bad github handle; and grant before init', () => {
  const { run } = rig();
  assert.match(run('grant', { input: JSON.stringify({ label: 'X Y' }) }).stdout, /no commons is configured/);
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  assert.match(run('grant', { input: JSON.stringify({}) }).stdout, /needs a label/);
  assert.match(run('grant', { input: JSON.stringify({ label: 'A', email: 'nope' }) }).stdout, /email/);
  assert.match(run('grant', { input: JSON.stringify({ label: 'A', github: 'bad handle' }) }).stdout, /GitHub/);
});

test('bundle: reprints the join bundle without touching the roster', () => {
  const { brain, run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  const r = run('bundle');
  assert.equal(r.status, 0);
  assert.ok(parseBundle(r.stdout.split('\n')[0]).ok);
  assert.ok(!existsSync(path.join(brain, 'registry', 'commons-roster.json')), 'no roster row from a reprint');
});
