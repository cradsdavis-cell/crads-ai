// brain-root.mjs — THE brain-root resolver. One truth, three forms.
//
// Where a box's org brain lives, resolved the way boot-rock.sh established
// (staged deployment.yaml value > baked env > /state/brain) plus the
// member-born leg proven on ingrid 2026-08-17: a promoted rock has no
// /state/brain and often an EMPTY deployment.yaml — its brain (.git + wiki/ +
// profile.yaml + org-policy.yaml) IS the box root. So the chain is:
//
//   deployment.yaml brain_root  >  $BRAIN_ROOT (baked env)  >  <box>/brain
//   ...and if the winner does not exist on disk, the box root itself.
//
// HISTORY, and why this module exists: this exact chain was hand-copied in at
// least TEN runtime call sites (BR_RESOLVE + PROMOTE_MINT_CMD +
// member-console-state in panel-server.mjs, box-cockpit.mjs, heartbeat.mjs,
// scheduler.mjs twice, device-sync.mjs, org-github-routes.mjs, and two
// harness utils), and FIVE of those readers independently missed the
// member-born leg — finding 107 counted them one at a time as each surfaced
// as a fresh bug (org verbs no-oping on ingrid, the Custody card reading
// "Could not read this rock's backup just now" forever, box-cockpit walking
// the wrong root). The sixth and seventh (heartbeat, scheduler) were found
// still missing it when this module was extracted. Copies drift; this file
// does not. brain-root.test.mjs greps the repo for stray re-implementations.
//
// DELIBERATELY EXEMPT — provisioning/ (boot-rock.sh, provision-rock.sh):
// those run at rock BIRTH, before the brain directory exists, so the
// does-it-exist fallback here would mis-resolve every newborn rock to the box
// root in the window before boot-rock creates the brain. Birth-time
// resolution is a different question and stays where it is.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BRAIN_ROOT_LINE = /^brain_root:\s*"?([^"\n#]*)"?/m;

// ---- org detection (one truth, same rule as box-kind) ----------------------
// Two ways a box is an org, and BOTH are normal:
//   * a born rock: org-policy.yaml at its resolved brain root (boot-rock seeds it)
//   * a member-born rock: NO org-policy.yaml AT ALL by design (the 2026-08-17
//     self-registration flow writes only ownership.json at the flip) — the
//     product-wide convention for recognising one is ownership.json carrying
//     tier "rock", exactly how the box-kind verb reads it.
// box-cockpit keyed on the policy file alone, so every member-born rock built
// its graph in pebble mode against org verbs rooted by resolveBrainRoot —
// finding 107 again, one detector further up.
export function readOwnership(stateDir = '/state') {
  try { return JSON.parse(readFileSync(path.join(stateDir, 'ownership.json'), 'utf8')); }
  catch { return null; }
}
export function isOrgBox(stateDir = '/state', { env = process.env } = {}) {
  if (existsSync(path.join(resolveBrainRoot(stateDir, { env }), 'org-policy.yaml'))) return true;
  return readOwnership(stateDir)?.tier === 'rock';
}

// ---- JS form (box-side callers with fs access) -----------------------------
export function resolveBrainRoot(stateDir = '/state', { env = process.env } = {}) {
  let stated = '';
  try {
    const m = readFileSync(path.join(stateDir, 'deployment.yaml'), 'utf8').match(BRAIN_ROOT_LINE);
    if (m) stated = m[1].trim();
  } catch { /* no deployment.yaml: a pebble, or a member-born rock */ }
  const root = stated || env.BRAIN_ROOT || path.join(stateDir, 'brain');
  return existsSync(root) ? root : stateDir;
}

// ---- shell form (verb builders; the command runs ON the box) ---------------
// Sets AND exports $BR so both the shell legs of a verb ("$BR/...") and any
// inline `node -e` it spawns (process.env.BR) read the same answer. The node
// one-liner mirrors BRAIN_ROOT_LINE exactly — the test pins that they agree.
export const BRAIN_ROOT_SH = 'BR="$(node -e \'const m=require("fs").readFileSync("/state/deployment.yaml","utf8").match(/^brain_root:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
  + 'BR="${BR:-${BRAIN_ROOT:-/state/brain}}"; '
  + '[ -d "$BR" ] || BR=/state; export BR; ';

// ---- the stamp (2026-08-17 hardening, part 1) ------------------------------
// Make the box SELF-DESCRIBING: write the resolved root into deployment.yaml
// as `brain_root:` when no line states it, so the fallback legs above become
// belt-and-braces rather than load-bearing. Two callers:
//
//   * PROMOTE_MINT_CMD appends BRAIN_ROOT_STAMP_SH, so every box stamps at
//     the moment it becomes a rock (idempotent, like the mint itself).
//   * The scheduler calls ensureBrainRootStamped() at boot — the BACKFILL for
//     boxes promoted before the stamp existed (ingrid, milk-and-honey).
//     It reaches them via the nightly image update, no operator ssh needed —
//     which matters, because the operator holds no rock's key any more.
//
// The JS backfill stamps ONLY org boxes (isOrgBox: org-policy.yaml at the
// resolved root, or ownership.json tier "rock"): a plain pebble resolves fine
// without a deployment.yaml and creating one on every pebble in the fleet is
// blast radius for nothing. The gate MUST include the ownership leg: the two
// boxes this backfill exists for (ingrid, milk-and-honey) are member-born and
// carry no org-policy.yaml by design, so a policy-only gate skipped exactly
// them ('not-org') and the backfill stamped nothing anywhere. The shell stamp
// has no such gate — it only ever runs inside the promote flip, where the box
// is becoming a rock by definition and org-policy may not be written yet at
// mint time.
export const BRAIN_ROOT_STAMP_SH = 'node -e \'const fs=require("fs"),p="/state/deployment.yaml";let s="";try{s=fs.readFileSync(p,"utf8")}catch{}'
  + 'if(!/^brain_root:/m.test(s)){if(s&&!/\\n$/.test(s))s+="\\n";fs.writeFileSync(p,s+"brain_root: "+process.argv[1]+"\\n")}\' "$BR"; ';

export function ensureBrainRootStamped(stateDir = '/state', { env = process.env } = {}) {
  const dep = path.join(stateDir, 'deployment.yaml');
  let s = '';
  try { s = readFileSync(dep, 'utf8'); } catch { /* absent is fine */ }
  if (BRAIN_ROOT_LINE.test(s)) return { stamped: false, reason: 'already-stated' };
  const root = resolveBrainRoot(stateDir, { env });
  if (!isOrgBox(stateDir, { env })) return { stamped: false, reason: 'not-org' };
  if (s && !s.endsWith('\n')) s += '\n';
  writeFileSync(dep, s + `brain_root: ${root}\n`);
  return { stamped: true, root };
}
