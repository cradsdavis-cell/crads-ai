// brain-script-guard.test.mjs — a verb that needs a brain script must say so in
// words when the brain hasn't got it.
// Run: node --test wizard/panel/brain-script-guard.test.mjs
//
// Why this file exists. Org verbs run scripts out of the rock's OWN
// brain repo (orchestrator/*.mjs). A brain seeded before a script existed
// simply does not have it, and nothing pulls new machinery down on its own. So
// pressing "Evict this member" on certrock answered with:
//
//   node:internal/modules/cjs/loader:1520
//     throw err;
//   Error: Cannot find module '/state/brain/orchestrator/evict-member.mjs'
//
// printed into the org console, at an admin, mid-eviction. push-ask and
// drop-membership already guarded themselves with a plain-words message; the
// rest did not, and the guard is exactly the kind of thing that gets forgotten
// on the next script. This test makes the convention structural: every
// orchestrator script a verb invokes must be tested for first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS } from './panel-server.mjs';

// Plausible arguments for every shape of verb; builders that reject them are
// skipped, since a verb we cannot build tells us nothing either way.
const ARGS = {
  slug: 'qa-wren', org: 'certrock', skill_id: 'cert-check', kind: 'ask-read',
  reason: 'unpaid since June', dir: 'org', confirm: 'qa-wren', note: 'n',
  id: 'a'.repeat(32), handle: 'acme-co', display: 'Acme Co', page: 'notes/x.md',
  version: 1, status: 'paused', to: 'beta', pubkey: 'ssh-ed25519 AAAA x', fp: 'ABC234',
};

function builtCommands() {
  const out = [];
  for (const [name, v] of Object.entries(VERBS)) {
    if (typeof v?.build !== 'function') continue;
    let cmd;
    try { cmd = v.build(ARGS)?.command; } catch { continue; }
    if (typeof cmd === 'string') out.push([name, cmd]);
  }
  return out;
}

test('every orchestrator script a verb runs is guarded by an existence test', () => {
  const cmds = builtCommands();
  assert.ok(cmds.length >= 20, `expected the verb table to still be here, built ${cmds.length}`);
  const bad = [];
  let seen = 0;
  for (const [verb, cmd] of cmds) {
    for (const m of cmd.matchAll(/node orchestrator\/([a-z0-9-]+)\.mjs/g)) {
      seen++;
      const script = m[1];
      // the `[ -f X ] && node X` form is its own guard
      if (!cmd.includes(`-f orchestrator/${script}.mjs`)) bad.push(`${verb} -> ${script}`);
    }
  }
  assert.ok(seen >= 8, `expected orchestrator-backed verbs, found ${seen}`);
  assert.deepEqual([...new Set(bad)], [], `these run a brain script with no existence guard: ${bad.join(', ')}`);
});

test('the guard explains itself in words and never leaks machine noise', () => {
  for (const [verb, cmd] of builtCommands()) {
    for (const m of cmd.matchAll(/-f orchestrator\/[a-z0-9-]+\.mjs \] \|\| \{ echo "([^"]+)"/g)) {
      const msg = m[1];
      assert.match(msg, /^ERROR: /, `${verb}: the guard must speak as an error`);
      assert.match(msg, /[Uu]pdate the brain/, `${verb}: the guard must say what to do`);
      assert.doesNotMatch(msg, /Cannot find module|node:internal/, `${verb}: no machine noise`);
    }
  }
});

// ---------------------------------------------------------------------------
// The org GitHub credentials must reach every verb that DELIVERS to a member.
// push-down.mjs (the shared deliverer behind push-ask, push-skill,
// push-member-key, the transfer pair, evict-member and drop-membership) exits 2
// with "ORG_GH_OWNER + ORG_GH_TOKEN required (.env)" when they are absent.
// SOFT_FACTORY_ENV exists to source them from /state/secrets and its own
// comment names that error — but two verbs never got the prefix, so on a box
// whose creds live in the factory env file (the default for a stamped rock)
// they could only ever fail. Hit live: evicting a member answered "REFUSED:
// could not deliver the eviction notice", and the honest-delivery rule then
// correctly kept the row open, so the org could not evict anybody at all.
const DELIVERS = [
  'push-ask', 'push-skill', 'unpush-skill', 'push-member-key',
  'transfer-invite', 'transfer-grant', 'transfer-org-complete',
  'evict-member', 'drop-membership',
];

test('every verb that delivers to a member is given the org credentials', () => {
  const missing = [];
  let checked = 0;
  for (const [verb, cmd] of builtCommands()) {
    const needs = DELIVERS.filter((s) => cmd.includes(`orchestrator/${s}.mjs`));
    if (!needs.length) continue;
    checked++;
    if (!cmd.includes('provisioning.env.local')) missing.push(`${verb} (${needs.join(', ')})`);
  }
  assert.ok(checked >= 8, `expected the delivering verbs to still be here, checked ${checked}`);
  assert.deepEqual(missing, [], `these deliver to a member with no org credentials: ${missing.join('; ')}`);
});
