// last-used.mjs — which mineral this computer had open last.
//
// Spec: docs/superpowers/specs/2026-08-13-mineral-inventory.md, ruling 6 of the
// upgraded-pebble spec ("launch = last-used box; door demotes to first-run").
//
// WHY A FILE AND NOT localStorage. The door has remembered the last-used
// identity since it was built, in localStorage under `aios_door_last`, and that
// record is invisible to the thing that needs it: app.mjs runs in Node, decides
// what window to open before any page exists, and cannot read a browser
// profile's storage. So the recency the door already had could never drive the
// launch. This is the same fact written where the launcher can see it.
//
// ~/.crads-ai/ rather than %LOCALAPPDATA%\Crads-AI\: app.mjs's RUN_DIR is
// platform-branched and not exported, while ~/.crads-ai already holds the app's
// own known_hosts (ssh-bridge.mjs:appKnownHostsPath) and is computed the same
// way from every process that needs it, on every platform.
//
// Deliberately tiny and total: every function swallows its own errors and
// returns a safe value. A launcher that crashed because a preference file was
// unreadable would be a far worse bug than opening the wrong screen.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The wizard-installed alias shapes, and nothing else. This value is read back
// and used to pick a surface, so it is validated on the way IN as well as out:
// a hand-edited file must not be able to steer the launcher at anything.
// -local joined 2026-09-11: a brain folder on this computer (local-targets.mjs).
const ALIAS_RE = /^[a-z0-9][a-z0-9-]*-(rock|box|local)$/;

export function lastUsedPath(dir = join(homedir(), '.crads-ai')) {
  return join(dir, 'last-used.json');
}

/** The alias this computer last opened, or '' when there is no usable record. */
export function readLastUsed(path = lastUsedPath()) {
  try {
    if (!existsSync(path)) return '';
    const alias = String(JSON.parse(readFileSync(path, 'utf8')).alias || '');
    return ALIAS_RE.test(alias) ? alias : '';
  } catch { return ''; }
}

/**
 * Record the alias at `path`. Returns whether it was actually written.
 *
 * THERE IS NO DEFAULT DESTINATION, and that is the fix. Writing this record is
 * OPT-IN: a caller that does not name a file writes nothing, anywhere. Only
 * `wizard/app.mjs` opts in, by passing `lastUsedPath()` to createPanelServer.
 *
 * Found four times, 2026-08-13 and 2026-08-14. Every time, something that was
 * not the app booted the REAL panel-server, a browser loaded member.html,
 * member.html POSTed /last-used on boot as it does on every boot, and the
 * operator's own ~/.crads-ai/last-used.json changed which mineral their app
 * would open next launch. Sites 1 to 3 were harnesses inside this repo
 * (.superpowers/qa/qa-harness.mjs, qa-not-let-in.test.mjs, qa-topology.test.mjs)
 * and got an override each; the earlier guard here refused only under
 * `node --test`. Site 4 was `/tmp/panel-member.mjs`, a two-line scratch driver
 * from a live QA session, still listening on 8861 a day later: not a test, not
 * in the repo, and unreachable by any enumeration of harnesses. Naming writers
 * one at a time is how the next one gets missed, so the default stopped being
 * "the operator's real file" and started being "nowhere". Same shape as "tests
 * never touch provisioning": give it a refusal it hits before the first write,
 * not discipline about remembering an override.
 */
export function writeLastUsed(alias, path) {
  if (!path) return false;
  const a = String(alias || '');
  if (!ALIAS_RE.test(a)) return false;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ alias: a, at: new Date().toISOString() }) + '\n');
    return true;
  } catch { return false; }
}

/**
 * The launch decision (ruling 6), as a pure function so it can be tested
 * without an ssh config, a browser or a window.
 *
 * Falls back to the door whenever the record cannot be honoured, which is the
 * whole safety of the thing: a mineral that was forgotten, torn down, or
 * renamed since must not strand the app pointing at nothing. The door is also
 * the only screen that can CREATE, so a fallback is never a dead end.
 *
 * @returns {{open:'panel'|'member'|'local'|'door', host?:string, slug?:string, why:string}}
 */
export function launchTarget(targets = [], last = '') {
  const rows = (targets || []).filter((t) => t && t.host);
  if (!rows.length) return { open: 'door', why: 'nothing installed' };
  const match = last ? rows.filter((t) => t.host === last) : [];
  if (!match.length) {
    return { open: 'door', why: last ? 'the last-used mineral is no longer on this computer' : 'no last-used record' };
  }
  // A promoted box has BOTH kinds under one alias (ssh-bridge's PROMOTED
  // overlay). It is one mineral and its rock face is the fuller one, so prefer
  // it -- the same call the inventory's collapse makes.
  const rock = match.find((t) => t.kind === 'rock');
  if (rock) return { open: 'panel', host: rock.host, why: 'last used' };
  // a brain folder opens on its alias (#host=), like a rock: its slug is not
  // a -box alias, so the #box= convention would miss it
  const local = match.find((t) => t.kind === 'local');
  if (local) return { open: 'local', host: local.host, slug: local.org, why: 'last used' };
  return { open: 'member', host: match[0].host, slug: match[0].org, why: 'last used' };
}
