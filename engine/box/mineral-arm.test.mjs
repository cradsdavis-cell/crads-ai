// mineral-arm.test.mjs — the pebble's directory leg, pinned at the three gates
// that were all open at once (2026-08-12).
//
// The bug this file exists for was invisible from every surface: the box was
// healthy, ssh worked, the app connected, and the mineral simply did not exist
// anywhere off the box. So these tests assert the GATES, in the shape the two
// consumers actually test them:
//
//   scheduler.mjs  [ -f secrets/box_directory_token ]
//   enrol-sync.mjs token && /^[0-9a-f]{64}$/.test(owner_e)
//   enrol-sync.mjs identityFacts(stateDir).holder
//
//   node --test engine/box/mineral-arm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armMineral, REG_HOST_RE } from './mineral-arm.mjs';
import { identityFacts, readOwnership, emailHash } from '../lib/mineral-identity.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A pebble as seed-pages.mjs actually births it: flat holder_email, no holder. */
const pebble = (own = {}) => {
  const d = tmpDir('mineral-arm-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({
    owner: 'member', managed_by: 'org', machinery_by: 'crads-ai', tier: 'pebble',
    anchor: 'crads-ai', holder_email: 'jane@example.com', grants: [], ...own,
  }, null, 2) + '\n');
  return d;
};
const ENV = { AIOS_BOX_HOST: 'jane01.crads-ai.com' };
const rd = (d, f) => readFileSync(join(d, 'secrets', f), 'utf8').trim();

test('a born pebble ends up past all three gates', () => {
  const d = pebble();
  const r = armMineral(d, { env: ENV });
  assert.equal(r.armed, true, r.reason);

  // gate 1: the scheduler's file test
  assert.ok(existsSync(join(d, 'secrets', 'box_directory_token')), 'the scheduler leg has something to unlock it');
  assert.ok(rd(d, 'box_directory_token').length >= 24, 'the directory refuses a token under 24 chars');
  // gate 2: enrol-sync's own guard, byte for byte
  assert.match(rd(d, 'owner_e'), /^[0-9a-f]{64}$/);
  assert.equal(rd(d, 'owner_e'), emailHash('jane@example.com'), 'the hash, never the address');
  // gate 3: the mirror's holder test
  const f = identityFacts(d);
  assert.ok(f.holder, 'identityFacts sees a holder object, not just a flat string');
  assert.equal(f.holder.email, 'jane@example.com');
  assert.match(f.mineral_id, /^min_[0-9a-f]{24}$/, 'and a serial to key the record on');
  // and the holder holds owner access, because grant-is-the-gate
  assert.equal(f.access.some((g) => g.email === 'jane@example.com' && g.role === 'owner'), true);
});

test('the host it registers is dialable, because a device Host block is written from it', () => {
  const d = pebble();
  assert.equal(armMineral(d, { env: ENV }).host, 'jane01.crads-ai.com');
  assert.equal(rd(d, 'box_reg_host'), 'jane01.crads-ai.com');

  // the pathology: os.hostname() inside a container IS the docker id, and the
  // directory's own HOST_RE would accept it
  assert.equal(REG_HOST_RE.test('1c8db1bea6a3'), false, 'a container id is not a name');
  assert.equal(REG_HOST_RE.test('noor'), false, 'nor is a bare member slug');
  const e = pebble();
  const r = armMineral(e, { env: {} });
  assert.equal(r.armed, false);
  assert.match(r.reason, /hostname/);
  assert.equal(existsSync(join(e, 'secrets', 'box_directory_token')), false,
    'and nothing is armed, so the leg stays quiet rather than registering a wrong name');
});

test('the token is written LAST, so the scheduler never runs against a half-armed box', () => {
  const d = pebble();
  assert.deepEqual(armMineral(d, { env: ENV }).wrote,
    ['box_reg_host', 'owner_e', 'box_directory_token'],
    'the file the guard tests is the last one to exist');
  // the same ordering, asserted where it is actually enforced
  const src = readFileSync(join(HERE, 'mineral-arm.mjs'), 'utf8');
  assert.ok(src.indexOf("push('owner_e')") < src.indexOf("push('box_directory_token')"));
});

test('re-arming is a no-op: nothing is re-minted on the second boot', () => {
  const d = pebble();
  armMineral(d, { env: ENV });
  const before = ['box_reg_host', 'owner_e', 'box_directory_token'].map((f) => rd(d, f));
  const again = armMineral(d, { env: ENV, mint: () => 'a-different-token-entirely-0123456789' });
  assert.equal(again.armed, true);
  assert.deepEqual(again.wrote, [], 'nothing rewritten');
  assert.equal(again.claimed, false, 'and the holder is not re-claimed');
  assert.deepEqual(['box_reg_host', 'owner_e', 'box_directory_token'].map((f) => rd(d, f)), before,
    'a re-minted token would lose the name: first token wins it at the directory');
});

test('a holderless pebble is left honestly unarmed rather than falsely attributed', () => {
  const d = pebble({ holder_email: '' });
  const r = armMineral(d, { env: ENV });
  assert.equal(r.armed, false);
  assert.match(r.reason, /holderless/);
  assert.equal(existsSync(join(d, 'secrets')), false, 'no secrets, no half-state');
  assert.equal(readOwnership(d).holder, undefined, 'and no holder invented from thin air');
});

test('provisioning can name the holder when the disk does not', () => {
  const d = pebble({ holder_email: '' });
  const r = armMineral(d, { env: { ...ENV, AIOS_OWNER_EMAIL: 'sam@example.com' } });
  assert.equal(r.armed, true);
  assert.equal(r.claimed, true);
  assert.equal(identityFacts(d).holder.email, 'sam@example.com');
});

test('an existing holder wins over the env, so a stamp cannot re-own a live mineral', () => {
  const d = pebble();
  armMineral(d, { env: ENV });                                   // jane holds it
  const r = armMineral(d, { env: { ...ENV, AIOS_OWNER_EMAIL: 'someone-else@example.com' } });
  assert.equal(r.armed, true);
  assert.equal(identityFacts(d).holder.email, 'jane@example.com');
  assert.equal(rd(d, 'owner_e'), emailHash('jane@example.com'), 'and owner_e still names jane');
});

test('an org-HELD mineral is left to the rock path', () => {
  const d = pebble({ holder: { kind: 'org', org: 'acme' } });
  const r = armMineral(d, { env: ENV });
  assert.equal(r.armed, false);
  assert.match(r.reason, /org-held/);
  assert.equal(existsSync(join(d, 'secrets', 'box_directory_token')), false);
});

test('an org-MANAGED member pebble is NOT org-held, and arms like any other', () => {
  // the normal Practice Partner shape: the rock manages it, the member holds it
  const d = pebble({ managed_by: 'org', owner: 'member' });
  assert.equal(armMineral(d, { env: ENV }).armed, true);
});

test('a box that never staged a hostname keeps a hand-written one', () => {
  const d = pebble();
  mkdirSync(join(d, 'secrets'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'box_reg_host'), 'repaired.crads-ai.com\n');
  const r = armMineral(d, { env: {} });
  assert.equal(r.armed, true, 'the file on disk is enough to arm a pre-existing box');
  assert.equal(r.host, 'repaired.crads-ai.com');
  assert.deepEqual(r.wrote, ['owner_e', 'box_directory_token']);
});

test('the member entrypoint actually calls it (an unwired arm is the same silence)', () => {
  const src = readFileSync(join(HERE, '..', 'box-up.sh'), 'utf8');
  assert.match(src, /box\/mineral-arm\.mjs/, 'box-up.sh runs the arming step');
  assert.ok(src.indexOf('seed-pages.mjs') < src.indexOf('mineral-arm.mjs'),
    'after seed-pages, which is what writes the ownership record it upgrades');
});

test('provisioning stages the hostname the container cannot learn for itself', () => {
  const tpl = readFileSync(join(HERE, '..', '..', 'provisioning', 'managed', 'cloud-init.template.yaml'), 'utf8');
  assert.match(tpl, /AIOS_BOX_HOST=__BOX_HOST__/, 'the env file carries it into the container');
  const prov = readFileSync(join(HERE, '..', '..', 'provisioning', 'managed', 'provision-pebble.sh'), 'utf8');
  assert.match(prov, /__BOX_HOST__\|\$BOX_HOST_SUB/, 'and provision-pebble.sh substitutes it');
});

// --- finding 100: a claimed pebble learns its holder from its anchoring rock ---
//
// Driven as a member on 2026-08-13: the claim did everything except tell the BOX
// whose it was. Device key minted, ssh door open, the rock committed "device
// enrolled via id_token, box active" — and this function answered "holderless"
// on the claimed box, so no registration secrets were ever written and the
// member's own /app/minerals read "Nothing to show for this account yet",
// permanently.
//
// push-member-key.mjs on the rock now writes the address into the member's inbox
// on every approval, and the pebble clones that inbox, so it arrives on disk with
// no new channel and no new credential.
test('100: a pebble arms from the address its rock pushed into the inbox', () => {
  // holder_email removed: this is a brokered pebble born with no address at all.
  const dir = pebble({ holder_email: '' });
  mkdirSync(join(dir, 'org-inbox', 'identity'), { recursive: true });
  writeFileSync(join(dir, 'org-inbox', 'identity', 'holder_email'), 'member@example.com\n');

  const r = armMineral(dir, { env: ENV });
  assert.equal(r.armed, true, `should arm from the rock-pushed address, got: ${r.reason}`);
  assert.equal(r.claimed, true, 'and the holder is claimed, which is what turns an address into access');
  const own = JSON.parse(readFileSync(join(dir, 'ownership.json'), 'utf8'));
  assert.equal(own.holder.email, 'member@example.com');
});

test('100: without it, the same box is honestly holderless', () => {
  // The bug, pinned. Remove only the pushed address and nothing else changes.
  const dir = pebble({ holder_email: '' });
  const r = armMineral(dir, { env: ENV });
  assert.equal(r.armed, false);
  assert.match(r.reason, /holderless/);
});

test('100: a box that already names a holder is never re-attributed from outside', () => {
  // Rock-pushed ranks BELOW anything on the box. An inbox is content the rock
  // controls, so it must never be able to take over a mineral that is already
  // someone's.
  const dir = pebble({ holder: { kind: 'account', email: 'real@example.com' }, holder_email: '' });
  mkdirSync(join(dir, 'org-inbox', 'identity'), { recursive: true });
  writeFileSync(join(dir, 'org-inbox', 'identity', 'holder_email'), 'attacker@example.com\n');

  armMineral(dir, { env: ENV });
  const after = JSON.parse(readFileSync(join(dir, 'ownership.json'), 'utf8'));
  assert.equal(after.holder.email, 'real@example.com', 'the inbox must not be able to re-own a mineral');
});
