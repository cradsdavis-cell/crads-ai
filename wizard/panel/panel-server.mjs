// panel-server.mjs: the control panel's local loopback server (D43). Same shape
// as ui/server-lib.mjs: serves the SPA, streams every verb as SSE. The browser
// NEVER sends shell; it sends { host, verb, args } and only verbs in the VERBS
// whitelist below map to commands, each built server-side from validated args.
//
// The remote side: the wizard-installed `<org>-rock` Host alias force-lands
// every command inside the rock's ai-os container (ForceCommand enter-aios),
// so paths here are container paths: the org brain at its resolved brain_root
// (BR_RESOLVE below; /state/brain unless deployment.yaml moves it),
// the provisioning checkout at /app, factory tokens at
// /state/secrets/provisioning.env.local, provision state at /state/.factory.
//
// Roles (D43): the panel process carries ONE role (opts.role, default admin: an
// operator email cannot be derived from an SSH key, so staging defaults to Admin
// and the UI shows which role is active). Support never reaches destroy, policy,
// or secrets: ADMIN-ONLY verbs 403 server-side, the UI also hides the sections.
//
// Push note: the rock clones the brain with a READ-ONLY deploy key, so plain
// `git push` can fail there. Mutating verbs commit locally, then try origin, then
// fall back to an https push with ORG_GH_TOKEN from /state/brain/.env (the same
// var the factory already requires). A failed push is a loud WARN, never silent.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemBridge, forgetHost, hostNameFor, userKnownHostsPath, appKnownHostsPath, rawSsh, runSsh, matchesKind } from './ssh-bridge.mjs';
import { createOwnBrainRoutes } from './own-brain-routes.mjs';
import { createOrgGitHubRoutes } from './org-github-routes.mjs';
import { createMcpOAuthRoutes } from './mcp-oauth-routes.mjs';
import { createMcpDirectoryRoutes } from './mcp-directory-routes.mjs';
import { createGoogleConnectRoutes } from './google-connect-routes.mjs';
import { fetchChangelog, plainRelease } from './updater.mjs';
import { tieCounts } from './tie-counts.mjs';
import { seal as sealEnvelope, open as openEnvelope, ensureVaultKeypair } from './vault-crypto.mjs';
import { machineName } from './device-enrol.mjs';
import { inventoryRoutes } from './inventory-routes.mjs';
import { writeLastUsed } from './last-used.mjs';
import { parseOwnership } from './face-probe.mjs';
import { BRAIN_ROOT_SH, BRAIN_ROOT_STAMP_SH } from '../../engine/lib/brain-root.mjs';
import { crossOriginBlocked, refuseCrossOrigin } from './same-origin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- validation
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;         // 2..32, DNS-safe
// THE ORG HANDLE, byte-identical to directory/worker.js (2026-08-20 audit).
// Four org-handle checks in this file were hand-inlined as
// /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, which admits 2 to 40 characters, while the
// directory registers handles of 1 to 63. Nothing in the birth path caps below
// that: /register and /create-request both apply ORG_RE and no separate length
// check, and the door's handle input carries neither maxlength nor pattern. So a
// legitimately registered 41-to-63-character handle, or a single-character one,
// was refused panel-side, taking handover, transfer, custody and rock-leave with
// it. Two more checks (promote start and its flip) still used the pre-2026-08-13
// permissive form /^[A-Za-z0-9][A-Za-z0-9 _-]{0,62}$/, which accepts uppercase
// and SPACES: the panel took "Acme Collab", the worker refused it downstream,
// and a validation disagreement surfaced as a late 400. One constant, pinned to
// the worker's by promote-flow.test.mjs.
const ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A MINERAL slug, byte-identical to the directory's SLUG_RE (2 to 40). Distinct
// from SLUG_RE above, which is this file's own stricter 2-to-32 deployment name.
const MINERAL_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-rock$/;
const MEMBER_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-box$/;      // member edition (D44)
// The platform's own lanes, which are never rocks (2026-08-17, finding 168). A
// standalone pebble is anchored to `crads-solo` (SOLO_ORG in member-connect.mjs,
// the staging lane the Mountain mints through) and its mirrored record reads
// anchor `crads-ai` (MOUNTAIN_ANCHOR in directory/worker.js). Both mean the same
// thing: no rock above you, hosted and billed directly by Crads AI. The edges
// carrying them are REAL and stay in _communityMine.edges untouched — T7 anchor
// wiring and the strength sync still read them — but any surface that lists
// ROCKS (the Rocks page via /rock-mine, ties.json via syncTiesToBox, and the
// map that reads ties.json) must not present a platform lane as a community the
// member tied to. Observed live: a fresh solo pebble's Rocks page showed an
// ANCHORED card named "crads-solo", an internal handle that means nothing to
// the member it was shown to, sitting above the very sentence that says a solo
// pebble is "hosted and billed directly".
const PLATFORM_LANES = new Set(['crads-solo', 'crads-ai']);
// The promotion consent sentence — MUST mirror directory/worker.js PROMOTE_CONSENT
// verbatim (a parity test pins the two). The API refuses anything else, so no UI
// can soften the moment into a checkbox.
const PROMOTE_CONSENT = "my personal brain becomes this rock's brain";
// The verified PRE-COPY (ruling: no verified backup, no promotion): a REAL push to
// the member's OWN backup remote, run on the box, echoing the repo it pushed to.
// Exit 78 = no remote connected (the honest refusal path).
const PRECOPY_CMD = 'cd /state || exit 1; R="$(git remote | head -1)"; '
  + '[ -n "$R" ] || { echo "PRECOPY-NONE: no backup remote connected"; exit 78; }; '
  + 'git add -A >/dev/null 2>&1; git commit -qm "pre-promotion copy" >/dev/null 2>&1; '
  + 'git push -q "$R" || { echo "PRECOPY-PUSH-FAILED"; exit 79; }; '
  + 'echo "PRECOPY-OK $(git remote get-url "$R")"';
// THE ANCHOR COMES OFF FIRST (Sam's ruling 2026-08-10). An anchored pebble may
// now promote, and a rock is never anchored to a rock, so the anchor is dropped
// as part of the upgrade instead of being refused. This is byte-for-byte the
// detach the member's own `leave-org` verb performs, and deliberately so: the
// rock's side of a departure is already built around that exact shape (the
// leave marker up the heartbeat repo, which the rock's leave-reconcile reads to
// flip the row and detach the door key), and inventing a second "unanchor"
// marker would need a brain-template change that STANDING ROCKS CANNOT PULL.
//
// What survives it is the COMMUNITY JOIN, and that lives somewhere else: the
// directory edge, downgraded anchored -> joined by the member's own
// authenticated call before this runs. Community membership has never had a
// registry row (an accepted `joined` rock-tie writes an edge and nothing else),
// so "the row goes left, the edge stays joined" is the model's own shape, not a
// special case. The order matters and is enforced in /promote/flip: downgrade
// the edge, THEN publish the leave, or the rock's next reflect would prune the
// tie it is meant to keep.
//
// Exit 0 with nothing done when the box is not anchored: the flip is retryable
// and must be safe to re-run.
// `by` names the leg that ended the anchor ('promote' or 'downgrade', R23:
// the member changed the tie to a join). Both are ORG_RE-shaped words we
// choose, never user input. The downgrade leg also writes the Mountain into
// ownership.json, because the box stays a pebble and its record must agree
// with the directory's (uniform anchor rule: anchored to crads-ai, never to
// nothing).
// The catalogue merge behind catalog-list: one JSON over every inbox on the
// box. Single quotes are out (the program rides inside bash single quotes).
const CATALOG_MERGE_JS = 'const fs=require("fs");const path=require("path");'
  + 'const rd=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return null}};'
  + 'const val=(f,k)=>{try{const m=fs.readFileSync(f,"utf8").match(new RegExp("^"+k+"=(.*)$","m"));return m?m[1].trim().replace(/^"|"$/g,""):""}catch{return ""}};'
  + 'const out={items:[],inboxes:[]};'
  + 'const anchor=rd("/state/org-inbox/catalog/catalog.json");'
  + 'const ac=rd("/state/org-contact.json")||{};'
  + 'const aOwner=val("/state/org-inbox.conf","ORG_GH_OWNER");'
  + 'if(anchor&&typeof anchor==="object"){for(const k of Object.keys(anchor))if(k!=="items")out[k]=anchor[k];'
  + 'const aid=String(ac.org||aOwner||"");const alabel=String(anchor.rock||ac.org||ac.name||aOwner||"");'
  + 'out.inboxes.push({rock_id:aid,rock:alabel,owner:aOwner,anchor:true});'
  + 'for(const it of (Array.isArray(anchor.items)?anchor.items:[])){if(!it||typeof it!=="object")continue;'
  + 'out.items.push(Object.assign({},it,{rock:it.rock||alabel||undefined,rock_id:it.rock_id||aid||undefined}))}}'
  + 'let owners=[];try{owners=fs.readdirSync("/state/org-inbox.d").filter((f)=>f.endsWith(".conf")).map((f)=>f.slice(0,-5)).filter((o)=>/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(o)).sort()}catch{}'
  + 'for(const owner of owners){const conf="/state/org-inbox.d/"+owner+".conf";const rid=val(conf,"ORG")||owner;'
  + 'const cat=rd("/state/org-inbox.d/"+owner+"/catalog/catalog.json");const label=String((cat&&cat.rock)||rid);'
  + 'out.inboxes.push({rock_id:rid,rock:label,owner:owner,anchor:false});'
  + 'for(const it of (cat&&Array.isArray(cat.items)?cat.items:[])){if(!it||typeof it!=="object")continue;'
  + 'out.items.push(Object.assign({},it,{rock:it.rock||label,rock_id:rid}))}}'
  + 'process.stdout.write(JSON.stringify(out))';

export const unanchorCmd = (by) => 'set -e; '
  + '[ -f /state/org-inbox.conf ] || { echo "UNANCHOR-NONE: not anchored to a rock"; exit 0; }; '
  + '. /state/org-inbox.conf; '
  + 'if [ -f /state/heartbeat.conf ] && [ -f /state/secrets/heartbeat_deploy_key ]; then '
  + `node -e 'const fs=require("fs");fs.writeFileSync("/state/left.json",JSON.stringify({left:new Date().toISOString().slice(0,10),by:"${by}"})+"\\n")'; `
  + 'W=/state/.leave; rm -rf "$W"; '
  + 'export GIT_SSH_COMMAND="ssh -i /state/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"; '
  + 'git clone -q --depth 1 "${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}" "$W"; '
  + `node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/leave.json",JSON.stringify({at:new Date().toISOString().slice(0,10),by:"${by}"})+"\\n")' "$W"; `
  + `cd "$W"; git add leave.json; git -c user.name=mineral -c user.email=mineral@mineral.local commit -q -m "leave: anchor ${by === 'promote' ? 'dropped on promotion' : 'changed to a join'}" 2>/dev/null || true; `
  + 'git push -q origin HEAD; rm -rf "$W"; fi; '
  // The detach itself, last because the push above needs the very credentials it
  // removes. Both background jobs self-guard on their conf and exit 0 without
  // it, so removing the confs IS the detach.
  + 'rm -f /state/heartbeat.conf /state/org-inbox.conf /state/org-contact.json; '
  + 'rm -f /state/secrets/heartbeat_deploy_key /state/secrets/org_inbox_deploy_key; '
  + (by === 'downgrade'
    ? `node -e 'const fs=require("fs");const f="/state/ownership.json";try{const j=JSON.parse(fs.readFileSync(f,"utf8"));j.anchor="crads-ai";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")}catch(e){}'; `
    : '')
  + 'echo "UNANCHOR-OK"';
export const PROMOTE_UNANCHOR_CMD = unanchorCmd('promote');

// The box-side half of promotion: tier rock, owner the org itself (a rock is
// org-owned by definition), anchor the Mountain.
//
// The anchor line is new (2026-08-10) and it is a backstop, not the mechanism:
// PROMOTE_UNANCHOR_CMD above does the real work of ending the tie. Before
// anchored pebbles could promote, this comment read "anchor facts are untouched
// — rocks anchor to the Mountain, which is already what the record says", and
// that assumption dies with the ruling. If the detach were ever skipped, a
// promoted box would sit there calling itself a rock while its own record named
// a rock above it, which the uniform anchor rule calls illegal and which
// nothing downstream would reconcile.
// handle is ORG_RE-validated (alphanumerics, space, _ and -), so embedding it in
// double quotes inside the single-quoted shell string cannot break out.
export const promoteFlipCmd = (handle) => `node -e '`
  + `const fs=require("fs");const f="/state/ownership.json";`
  + `const j=JSON.parse(fs.readFileSync(f,"utf8"));`
  + `j.tier="rock";j.owner="org";j.owner_slug="${handle}";j.anchor="crads-ai";`
  + `fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n");`
  // The pending marker dies WITH the flip, in the same command, because the
  // two facts are one fact: a box that is a rock has no promotion in flight.
  // Left behind, it would make the seat resume a watch forever on a promotion
  // that already landed.
  + `try{fs.unlinkSync("/state/promotion-pending.json")}catch(e){}`
  + `console.log("promoted: this mineral is a rock, personal seat intact")'`;

// SELF-REGISTRATION (Sam's ruling 2026-08-17: "a promoted rock is just the
// same as a normal rock"). A normal rock mints its own ORG_PULL_TOKEN into its
// brain .env and registers itself; the operator never holds it. So the flip
// now starts with exactly that: mint (or reuse — idempotent across retries,
// which is what lets a crashed flip run the register leg again with the same
// token and get the worker's already:true) and read back the token plus the
// box's own public host, and the app claims the handle the ask reserved at the
// directory. The claim carries the MEMBER's signed id token; the worker
// converts the reservation only for the email that reserved it, and only once
// the fulfilment record says done.
//
// The token never leaves the member's own machinery: minted on the box, sent
// once from the member's own app to the directory (which stores only its
// hash), exactly like a born rock's broker-register.
// Resolution + STAMP: the mint resolves the brain root through the shared
// fragment (same truth as every org verb — the token has to land in the .env
// of the brain that actually exists, which on a member-born box is /state
// itself), then writes that answer into deployment.yaml as `brain_root:` if
// no line states it. From this moment the rock is SELF-DESCRIBING: no future
// reader needs the existence-fallback leg to find its brain. Idempotent both
// halves, like the whole mint — a crashed flip re-runs this and changes
// nothing. Boxes promoted before the stamp existed are backfilled by the
// scheduler's ensureBrainRootStamped() at boot (see brain-root.mjs).
export const PROMOTE_MINT_CMD = BRAIN_ROOT_SH + BRAIN_ROOT_STAMP_SH
  + 'T="$(grep \'^ORG_PULL_TOKEN=\' "$BR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')"; '
  + 'if [ -z "$T" ]; then T="$(node -e \'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))\')"; '
  + 'printf \'\\nORG_PULL_TOKEN=%s\\n\' "$T" >> "$BR/.env"; fi; '
  + 'D="$(node -e \'const m=require("fs").readFileSync("/state/deployment.yaml","utf8").match(/^domain:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
  // the box states its token and its domain; the SLUG stays the app's fact
  // (it is the configured target's name), so no hostname guessing here
  + 'node -e \'const [t,d]=process.argv.slice(1);console.log("PROMOTE_REG "+JSON.stringify({token:t,domain:d||""}))\' "$T" "$D"';

// THE PENDING-PROMOTION MARKER (2026-08-17). A promotion is the one flow where
// the box-side finish is driven by a PAGE: only the seat's watcher calls
// /promote/flip. Until this existed the watcher was started in exactly one
// place, the button's own click handler, so anything that ended the page ended
// the promotion — while the card explicitly invited it ("you can close this and
// come back"). Closing the tab, losing the connection, opening the app on
// another device, or hitting one transient failure left the mineral registered
// as a rock at the directory and billed at the rock tier while its own
// ownership record still said pebble, with no route back to the flip except
// pressing promote again and filing a second request.
//
// Found on the first real promotion (2026-08-17): a register 400 stopped the
// watcher, the retry fulfilled server-side, and the box never flipped.
//
// The marker lives ON THE BOX, not in localStorage, because the box is the only
// party to this that survives a closed browser, a different device and an app
// reinstall — the same reason the map reads live from the box.
// The id is hex and the handle is ORG_RE-validated, but the JSON is base64'd
// anyway so no value is ever interpolated into a shell string.
export const promotePendingWriteCmd = (id, handle) =>
  `printf %s '${Buffer.from(JSON.stringify({ id, org_handle: handle, at: Date.now() })).toString('base64')}'`
  + ` | base64 -d > /state/promotion-pending.json`;
export const PROMOTE_PENDING_CLEAR_CMD = 'rm -f /state/promotion-pending.json; echo "PENDING-CLEARED"';

// The box-side half of demote: give the box back. It must reverse EXACTLY what
// promoteFlipCmd wrote — tier, owner and owner_slug — not only the tier.
//
// It used to touch the tier alone, deliberately ("so the owner pointer... survive
// the retirement untouched"), and that left a retired rock reading owner:"org"
// with a pointer to a handle that no longer exists. The person's seat then said
// "owned and managed by your rock", their backup line named the retired
// handle, and Connect my GitHub answered "the brain belongs to the rock.
// Ask them to grant the transfer" — with no rock left to ask and no
// other route to custody. Retire exists only for a rock started in
// place on a personal box, so the box was a personal pebble before, and a pebble
// is member-owned by definition. Anchor and machinery facts are still none of
// demotion's business and stay untouched.
export const DEMOTE_CMD = `node -e '`
  + `const fs=require("fs");const f="/state/ownership.json";`
  + `const j=JSON.parse(fs.readFileSync(f,"utf8"));`
  + `if(j.tier!=="rock"){console.log("already a pebble");process.exit(0)}`
  + `j.tier="pebble";j.owner="member";delete j.owner_slug;`
  + `fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n");`
  + `console.log("demoted: this mineral is a pebble again, and yours")'`;
// A host this server may act on. The SUFFIX is a shape check only: a box
// PROMOTED from a pebble keeps its `<slug>-box` alias and is served by the org
// edition, so insisting on `-rock` here rejected every org verb on exactly the
// boxes slice 1 had just taught the app to list. The real authorisation is
// membership of this edition's configured target list, which is strictly
// stronger than any name pattern.
const hostShapeOk = (host) => HOST_RE.test(host) || MEMBER_HOST_RE.test(host);
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const WORD_RE = /^[a-z0-9-]{1,32}$/;                          // tier / region
const B64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]{1,64})?$/;
// ---- the community join bundle (commons-repo model, self-host pivot) -------
// APP-SIDE SHALLOW CHECK ONLY: engine/community/commons-lib.mjs parseBundle
// is the authority and re-parses on the box. This exists so a mangled paste
// is refused in the browser with the reason named, before an SSH round trip.
// commons-verbs.test.mjs pins parity with the engine parser over a shared
// fixture set, so the two cannot silently drift on what they accept.
const COMMONS_ORG_RE = /^[a-z0-9][a-z0-9-]{0,36}[a-z0-9]$/;
const COMMONS_URL_RE = /^(https:\/\/[A-Za-z0-9][A-Za-z0-9.:-]*\/[^\s]+|ssh:\/\/[^\s]+|git:\/\/[^\s]+|[A-Za-z0-9][A-Za-z0-9._-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+)$/;
export function checkJoinBundle(s) {
  const no = (error) => ({ ok: false, error });
  const t = String(s ?? '').trim();
  if (!t) return no('the bundle is empty. Copy it whole from the community owner.');
  if (t.length > 4096) return no('that is too long to be a community bundle. Copy it exactly, nothing around it.');
  if (!t.startsWith('cradscommons1:')) return no('that does not look like a community bundle (it should start with "cradscommons1:"). Copy it whole from the community owner.');
  const body = t.slice('cradscommons1:'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return no('the bundle is damaged (its encoded part is not base64). Copy it again from the community owner.');
  let b;
  try { b = JSON.parse(Buffer.from(body, 'base64').toString('utf8')); } catch { b = null; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('the bundle is damaged (it does not decode to a community record). Copy it again from the community owner.');
  if (!COMMONS_ORG_RE.test(String(b.org || ''))) return no('the bundle is damaged (its community name is not usable). Ask the owner for a fresh one.');
  const url = String(b.url || '');
  if (!COMMONS_URL_RE.test(url) || url.length > 300 || url.includes('..')) return no('the bundle is damaged (its repository address is not an https, ssh or git URL). Ask the owner for a fresh one.');
  if (b.branch !== undefined && b.branch !== null && String(b.branch) !== '') {
    const br = String(b.branch);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,98}$/.test(br) || br.includes('..')) return no('the bundle is damaged (its branch name is not usable). Ask the owner for a fresh one.');
  }
  return { ok: true, org: String(b.org), org_display: String(b.org_display || b.org).slice(0, 64) };
}
const pubkeyArg = (v) => {
  if (!PUBKEY_RE.test(String(v ?? ''))) bad('that pubkey doesn’t look right: it should be ONE line starting with "ssh-ed25519". Re-copy the whole line exactly as it was sent (no line breaks, nothing added)');
  return String(v);
};
// Brain-viewer page paths: kebab/dotted relpaths ending .md; each segment must
// start alphanumeric OR underscore (no dotfiles, no `-flag` lookalikes, no `..`
// traversal).
//
// THE UNDERSCORE IS NOT COSMETIC (finding 107, 2026-08-13). `/onboard` writes
// every layer to `wiki/_layers/<n>-<name>.md`, so requiring a leading
// alphanumeric refused the ENTIRE product of onboarding while allowing
// `wiki/people/sam-davis.md` beside it. Driven live on a fully onboarded rock:
// the Brain graph rendered all eight layers and invited "click any to focus",
// and brain-read answered "page must be a relative .md path". Eight pages the
// owner had just spent an interview creating, unopenable in their own app.
//
// A leading underscore is safe and a leading DOT is still not: the dotfile ban
// is what keeps `.git/`, `.claude-auth/` and `.kernel/` out of a page reader,
// and it stays enforced by the segment check in pageArg below. `..` traversal is
// refused there too, so widening this class cannot reach outside the brain.
const PAGE_RE = /^[a-z0-9_][a-z0-9._-]*(\/[a-z0-9_][a-z0-9._-]*)*\.md$/i;
const pageArg = (v) => {
  const s = String(v ?? '');
  if (!PAGE_RE.test(s) || s.length > 200 || s.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) {
    bad('page must be a relative .md path (letters/digits/dots/dashes, no dotfiles, no traversal)');
  }
  return s;
};

// ---- brain ASSETS (2026-08-17): a brain is not only its prose --------------
// Until now the viewer was .md-ONLY, and that was doing double duty: it was the
// file filter AND the entire secrecy boundary. The comment on brainVerbs said so
// out loud — machine/secret files are "unreachable by construction, not by
// deny-list". A member with a photo, a scan or an exported spreadsheet in their
// own wiki simply could not see it in their own app.
//
// Widening the filter therefore has to REPLACE the boundary it was standing in
// for, not just relax it. Three rules do that, and all three are enforced here
// rather than in the shell command, so a caller cannot talk its way past them:
//
//   1. EXTENSION ALLOW-LIST, never a deny-list. Sam's ruling 2026-08-17: images
//      (png/jpg/jpeg/gif/webp) and flat text (txt/csv/tsv) join .md. Everything
//      else stays as unreachable as it was yesterday.
//   2. THE REFUSED SET IS NAMED AND TESTED. .env, .json, .yaml/.yml and every
//      dotfile stay out. They are excluded by rule 1 already (allow-list), but
//      asset-scope.test.mjs asserts them BY NAME so a future widening cannot
//      readmit a secret carrier by accident. Belt and braces on purpose: this is
//      the one place where a mistake hands a stranger a credential.
//   3. NO SVG, NO PDF, NO SOURCE CODE. SVG carries script, PDF is a large-binary
//      transport problem on a line-based channel, and source files are where a
//      rock's machinery lives (registry/, control/, factory/, orchestrator/,
//      tools/). All three were considered and refused, not overlooked.
//
// The segment rules (no dotfiles, no `..`, no leading `-`) are shared with
// pageArg above, so widening the extension class cannot reach outside the brain.
const TEXT_EXT = ['md', 'txt', 'csv', 'tsv'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const ASSET_EXT = [...TEXT_EXT, ...IMAGE_EXT];
// Named for the test, and for the next person tempted to add "just one more".
const REFUSED_EXT = ['env', 'json', 'yaml', 'yml', 'svg', 'pdf', 'js', 'mjs', 'py', 'sh', 'sql'];
const extOf = (s) => (s.split('.').pop() || '').toLowerCase();
const SEG_RE = /^[a-z0-9_][a-z0-9._-]*$/i;
// A relpath whose segments are safe and whose extension is in `exts`.
const relArg = (v, exts, what) => {
  const s = String(v ?? '');
  const segs = s.split('/');
  const ok = s.length <= 200
    && segs.length > 0
    && segs.every((seg) => SEG_RE.test(seg) && seg !== '..' && !seg.startsWith('.'))
    && exts.includes(extOf(s));
  if (!ok) bad(`${what} must be a relative path ending .${exts.join(' / .')} (no dotfiles, no traversal)`);
  return s;
};
// Readable-as-text: the markdown reader plus the flat-text families.
const textArg = (v) => relArg(v, TEXT_EXT, 'page');
// Readable-as-base64: images only. Nothing else ever takes the binary path.
const imageArg = (v) => relArg(v, IMAGE_EXT, 'image');

function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }
// Secret names are their own shape (up to 64 chars, matching engine/vault's
// VALID_NAME) and must never be able to escape the vault directory.
const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
// An MCP service key reaches a shell word, so it is an ALLOW-LIST of the three
// the box knows, not a pattern. mcp-connect.mjs refuses anything outside its
// catalogue too; this stops the string before it is ever interpolated.
// Any server name, not a fixed trio (Sam's ruling 2026-08-09: the catalogue is a
// convenience, never a boundary). Shape-validated because it reaches a shell word;
// mcp-connect.mjs re-validates against what is actually connectable.
const MCP_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const mcpKeyArg = (v) => {
  if (typeof v !== 'string' || !MCP_KEY_RE.test(v)) bad('a service name is 2-32 characters: lowercase letters, digits, - or _');
  return v;
};
const secretNameArg = (v) => {
  if (typeof v !== 'string' || !SECRET_NAME_RE.test(v)) bad('a secret name must be lowercase letters, numbers and dashes (2 to 64 characters), for example "gmail-token"');
  return v;
};
const slugArg = (v, name = 'slug') => {
  if (typeof v !== 'string' || !SLUG_RE.test(v)) bad(`the short username (${name}) must be 2-32 characters using only lowercase letters, numbers and hyphens, and can't start or end with a hyphen. Example: jane01`);
  return v;
};
// POSIX single-quote escaping; also refuses control chars so a crafted display
// name can never smuggle bytes into the remote shell line.
const shq = (v, name, max = 200) => {
  const s = String(v ?? '');
  if (!s || s.length > max) bad(`${name} is required (max ${max} chars)`);
  if (/[\x00-\x1f\x7f]/.test(s)) bad(`${name} must not contain control characters`);
  return `'${s.replace(/'/g, `'\\''`)}'`;
};

// ---- Standalone library items (delivery-model step 7) ------------------
// Until this step, prompt-write and page-write could only write INSIDE a pack,
// so sharing one prompt cost the operator a pack manifest. Both verbs now also
// accept target:'library', which writes the item to its own library root
// (prompts-library/<id>/, pages-library/<id>/) exactly as
// brain-template's readKind() expects to find it.

// The six-value platform taxonomy (ai-os spec 2026-08-09 § R7). This is a COPY
// of brain-template control/catalog-lib.mjs CATEGORIES, which is the enforcing
// end: enforceCategories() REFUSES any item whose category is not one of these,
// by name, with no default. An item authored here with a category this list
// does not contain would therefore publish to nothing, so it is refused at
// authoring time instead, where the operator is still holding the text.
const ITEM_CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];

// One manifest scalar, sanitised rather than quoted-and-hoped. The consuming
// reader is a line regex (^key:\s*"?([^"\n#]*)"?), so an operator title
// carrying a newline, a double quote or a '#' would truncate the value or
// forge a second field. Control characters go too: the result is base64'd into
// the command line by manifestB64 below, so no operator byte is ever parsed by
// the remote shell, but the manifest still has to survive its own parser.
const manifestScalar = (v, max = 120) => String(v ?? '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/[\x00-\x1f\x7f]/g, '')
  .replace(/["\\#]/g, '')
  .trim()
  .slice(0, max);

// A complete starter manifest for a standalone item, base64'd for safe
// transport through the command string. `id` is already kebab-case-validated by
// the caller. `version: 1` is the floor every reader parses with parseInt.
function manifestB64(id, a = {}) {
  const title = manifestScalar(a.title) || id;
  const description = manifestScalar(a.description, 200) || title;
  const category = manifestScalar(a.category, 60) || 'other';
  if (!ITEM_CATEGORIES.includes(category)) {
    bad(`category must be one of: ${ITEM_CATEGORIES.join(', ')}`);
  }
  const text = `id: ${id}\nversion: 1\ntitle: "${title}"\n`
    + `description: "${description}"\ncategory: "${category}"\n`;
  return Buffer.from(text, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- shell snippets
// Shared factory preamble: loud if the tokens are missing, then source them the
// way boot-rock stages them (PEBBLE_IMAGE included when the operator set one).
// THE ORG'S GITHUB, resolved the same way brain-template/factory/org-github.mjs
// resolves it, and for the same reason it exists at all.
//
// A rock born through the door stages no GitHub credential on purpose (the
// 2026-08-09 ownership ruling: the platform is never the default home for an
// organisation's artefacts), so its factory is armed by its owner running
// connect-github, which persists an account THEY own at GH_CONFIG_DIR. Until
// 2026-08-10 nothing on the stamp path knew that account existed, and New Pebble
// on test-org-4 died at "ORG_GH_OWNER + ORG_GH_TOKEN required (repo .env)".
//
// The brain-side resolver fixes it for rocks stamped from here on. It cannot
// fix the ones already standing: a rock cannot pull its own brain after the day
// it is born (see the note on the handshake audience below, same shape). This
// preamble is what reaches those, because the app updates and the box does not:
// it exports the pair, so an OLD brain's own chain finds it at rung one and
// behaves correctly without being touched.
//
// Coherence rule, identical to the resolver: the staged names win only as a
// PAIR. provision-rock could emit GITHUB_TOKEN=<platform> with GH_OWNER=""
// (fixed in the same change), and pairing the platform's token with an owner
// read off the org's connected account would push our credential at their repos.
const ORG_GH_RESOLVE = 'export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/state/.kernel/gh}"; '
  + 'export ORG_GH_OWNER="${ORG_GH_OWNER:-${IC_ORG:-${GH_OWNER:-}}}" ORG_GH_TOKEN="${ORG_GH_TOKEN:-${IC_ORG_TOKEN:-${GITHUB_TOKEN:-}}}"; '
  + 'if { [ -z "$ORG_GH_OWNER" ] || [ -z "$ORG_GH_TOKEN" ]; } && command -v gh >/dev/null 2>&1; then '
  + 'CT="$(gh auth token 2>/dev/null || true)"; '
  + 'if [ -n "$CT" ]; then '
  + 'CO="$(git -C "${BR:-/state/brain}" remote get-url origin 2>/dev/null | sed -nE \'s#.*github[.]com[:/]+([^/]+)/.*#\\1#p\' || true)"; '
  + '[ -n "$CO" ] || CO="$(gh api user -q .login 2>/dev/null || true)"; '
  + '[ -n "$CO" ] && export ORG_GH_OWNER="$CO" ORG_GH_TOKEN="$CT"; '
  + 'fi; fi; '
  // A MEMBER-BORN ROCK'S GITHUB LIVES WHERE THE MEMBER FLOW PUT IT (ingrid,
  // 2026-08-17). own-brain.mjs stores the member's device-flow token at
  // /state/.kernel/brain-github-token and wires git through a credential
  // helper — it never touches the gh CLI, so `gh auth token` above finds
  // nothing on a promoted rock. Result: the Custody card said "backed up,
  // last push 19:36" off that very token while factory-status said "No GitHub
  // account is connected" one tab over. Same disease as BR_RESOLVE's /state
  // fallback: a promoted rock is a normal rock (Sam's ruling), so the org
  // resolver reads the member credential as a LAST resort — env and gh still
  // win, and ORG_GH_VERIFY downstream still asks GitHub whether it is alive.
  + 'if { [ -z "$ORG_GH_OWNER" ] || [ -z "$ORG_GH_TOKEN" ]; } && [ -f /state/.kernel/brain-github-token ]; then '
  + 'CT="$(cat /state/.kernel/brain-github-token 2>/dev/null || true)"; '
  + 'if [ -n "$CT" ]; then '
  + 'CO="$(git -C "${BR:-/state/brain}" remote get-url origin 2>/dev/null | sed -nE \'s#.*github[.]com[:/]+([^/]+)/.*#\\1#p\' || true)"; '
  + '[ -n "$CO" ] || CO="$(GH_TOKEN="$CT" gh api user -q .login 2>/dev/null || true)"; '
  + '[ -n "$CO" ] && export ORG_GH_OWNER="$CO" ORG_GH_TOKEN="$CT"; '
  + 'fi; fi; export GH_TOKEN="${GH_TOKEN:-$ORG_GH_TOKEN}"; ';

// PRESENCE IS NOT PROOF. `gh auth token` keeps handing over a REVOKED token, so
// every check that asked "is there a token?" answered yes for a credential
// GitHub had already killed, and the app told Sam GitHub was connected minutes
// after he revoked it (2026-08-10). Ask GitHub.
//
// A failure to reach GitHub is NOT a bad credential: the same posture the
// brain-side preflight takes (verifyOwner). Only an explicit rejection counts,
// because a timeout cannot prove a negative and blocking a rock on our network
// weather would be the worse failure.
const ORG_GH_VERIFY = 'GHOK=""; '
  + 'if [ -n "${ORG_GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then '
  + 'if GHOUT="$(GH_TOKEN="$ORG_GH_TOKEN" gh api user -q .login 2>&1)"; then GHOK=1; '
  + 'else case "$GHOUT" in *"Bad credentials"*|*"401"*|*"Requires authentication"*) GHOK="";; *) GHOK=1;; esac; fi; '
  + 'fi; export GHOK; ';

// AND WHEN NOTHING RESOLVES, refuse HERE, in words.
//
// The gap this closes (found by Sam hitting the identical screen after the
// first fix shipped): resolving the connected account fixes a standing rock
// that HAS one. A rock that has never run connect-github has nothing to
// resolve, so control fell through to the brain, and an old brain's own guard
// printed the raw "ORG_GH_OWNER + ORG_GH_TOKEN required (repo .env)" exactly as
// before. The friendly version lives in factory/stamp-preflight.mjs, which a
// rock born before 2026-08-10 does not have and can never pull.
//
// So the app carries the refusal too. Same content as the brain's, and it must
// stay that way: this is the one an OLD rock sees, and old rocks are precisely
// the ones whose owner has no idea what ORG_GH_OWNER is.
//
// printf, NOT a heredoc: the whole verb travels as ONE shell string over ssh,
// and a heredoc would put raw newlines inside it for every layer in between to
// mishandle. One line in, many lines out.
const ORG_GH_REQUIRED = 'if [ -z "$ORG_GH_OWNER" ] || [ -z "$ORG_GH_TOKEN" ]; then printf "%s\\n" '
  + '"This rock has no GitHub account connected." '
  + '"" '
  + '"Every mineral this rock creates needs private repositories that YOUR organisation" '
  + '"owns: its update inbox, its heartbeat, and (when the rock owns the mineral) its" '
  + '"brain. Crads-AI never holds those for you, so this rock pushes them to an account" '
  + '"you own, and until one is connected it can neither create a mineral nor deliver to one." '
  + '"" '
  + '"To connect one, once: open this rock in the Terminal tab and run" '
  + '"" '
  + '"    connect-github" '
  + '"" '
  + '"then press Retry. Nothing has been created and no member has been changed." '
  + '"" '
  + '"(technical: ORG_GH_OWNER + ORG_GH_TOKEN unresolved. Checked the staged provisioning" '
  + '"env, the legacy IC_ORG names, and gh auth in GH_CONFIG_DIR on this box.)" '
  + '>&2; exit 1; fi; ';

// The five checks, for a brain too old to carry factory/stamp-preflight.mjs.
// Kept free of single quotes on purpose: it is embedded in a single-quoted shell
// word. Same ids, titles and JSON shape as the brain-side preflight.
const FACTORY_STATUS_FALLBACK = [
  'const e=process.env,fs=require("fs");',
  'const CONNECT="press Connect GitHub on this page (or run  connect-github  in the Terminal tab)";',
  'const STAGE="ask whoever set up this rock to stage its provisioning tokens";',
  'const c=[];',
  'const ghHave=e.ORG_GH_OWNER&&e.ORG_GH_TOKEN;',
  'c.push(ghHave&&e.GHOK',
  '?{id:"github",ok:true,title:"GitHub account",detail:"New minerals get their private repositories under "+e.ORG_GH_OWNER+".",fix:""}',
  ':ghHave',
  '?{id:"github",ok:false,title:"GitHub account",detail:"The connected GitHub account is no longer accepted (it looks revoked or expired), so nothing can be created under it.",fix:CONNECT}',
  ':{id:"github",ok:false,title:"GitHub account",detail:"No GitHub account is connected, so the private repositories a new mineral needs cannot be created.",fix:CONNECT});',
  'c.push(e.HCLOUD_TOKEN',
  '?{id:"server",ok:true,title:"Server provider",detail:"This rock can create machines.",fix:""}',
  ':{id:"server",ok:false,title:"Server provider",detail:"No server-provider token, so this rock cannot create the machine a mineral runs on.",fix:STAGE});',
  'c.push(e.CF_API_TOKEN&&e.CF_TUNNEL_ROOT_DOMAIN',
  '?{id:"address",ok:true,title:"Secure address",detail:"New minerals get an address under "+e.CF_TUNNEL_ROOT_DOMAIN+".",fix:""}',
  ':{id:"address",ok:false,title:"Secure address",detail:"No secure-address credentials, so a new mineral cannot be reached.",fix:STAGE});',
  'c.push(e.PEBBLE_IMAGE',
  '?{id:"image",ok:true,title:"Mineral software",detail:"New minerals run "+e.PEBBLE_IMAGE+".",fix:""}',
  ':{id:"image",ok:false,title:"Mineral software",detail:"The mineral software image is not set.",fix:STAGE});',
  'c.push(fs.existsSync("/app/provisioning/managed/provision-pebble.sh")',
  '?{id:"provisioning",ok:true,title:"Provisioning",detail:"Present on this box.",fix:""}',
  ':{id:"provisioning",ok:false,title:"Provisioning",detail:"This box is missing the provisioning that creates member machines.",fix:"restart this rock to pick up the latest published software"});',
  'process.stdout.write(JSON.stringify({armed:c.every(x=>x.ok),checks:c}));',
].join('');

const FACTORY_ENV = '[ -f /state/secrets/provisioning.env.local ] || { echo "ERROR: your hub is missing its one-time setup tokens, so it cannot create member minerals yet. Ask whoever set up your hub (technical detail: no /state/secrets/provisioning.env.local on the rock)."; exit 1; }; '
  + 'set -a; . /state/secrets/provisioning.env.local; set +a; export AIOS_DIR=/app AIOS_STATE_DIR=/state/.factory; '
  + ORG_GH_RESOLVE;
// ORG_GH_REQUIRED is applied PER VERB, not folded in here. FACTORY_ENV has five
// users and only four of them create or deliver GitHub repositories:
// invite-member, stamp-member, join-approve, ask-push. The fifth is
// deprovision-member, which needs the same Hetzner and Cloudflare tokens but
// only mentions the owner in one echo that already has a default. Gating it
// would strand a rock with no GitHub: unable to add a member AND unable to tidy
// up after itself. A refusal that removes the only remaining exit is worse than
// the error it replaces.

// SOFT variant for the verbs that PUSH from the brain clone (approve-device,
// member-revoke, skill-push). provision-rock gives the brain a read-only
// deploy key and stages the org token ONLY in the factory env (as GH_OWNER +
// GITHUB_TOKEN), so without this the first approval on a fresh org dies in
// push-member-key ("ORG_GH_OWNER + ORG_GH_TOKEN required"). Never hard-fails:
// a deployment that seeded the brain's .env instead has no factory env file
// and must keep working. Explicit ORG_GH_* (already in the environment) wins.
const SOFT_FACTORY_ENV = 'if [ -f /state/secrets/provisioning.env.local ]; then set -a; . /state/secrets/provisioning.env.local; set +a; fi; '
  + ORG_GH_RESOLVE;

// Commit-then-push with the read-only-deploy-key fallback described above.
const GIT_PUSH = 'if git push -q origin HEAD >/dev/null 2>&1; then echo "pushed"; '
  + 'else . ./.env >/dev/null 2>&1 || true; T="${ORG_GH_TOKEN:-${IC_ORG_TOKEN:-}}"; '
  + 'R="$(git remote get-url origin 2>/dev/null | sed -e \'s#^git@github.com:##\' -e \'s#^https://github.com/##\' -e \'s#[.]git$##\')"; '
  + 'if [ -n "$T" ] && [ -n "$R" ] && git push -q "https://x-access-token:$T@github.com/$R.git" HEAD >/dev/null 2>&1; then echo "pushed (org token)"; '
  + 'else echo "WARN: commit is local only, push failed (the brain clone uses a read-only deploy key; set ORG_GH_TOKEN in the brain\'s .env to let the panel push)"; fi; fi';

const GIT_ID = 'git -c user.name=Panel -c user.email=panel@rock.local';

// R26 (panel iteration 2): the origin header catalog-install writes into an
// installed SKILL.md's frontmatter. argv: <SKILL.md> <rock> <version>
// <installed>. Runs as `node -e '<this>'` so it must contain NO single quote.
// Keys already present are replaced where they are; missing ones are
// prepended so the provenance reads first; a file without frontmatter gets a
// block. Exported for the test that runs it against fixtures.
export const ORIGIN_HEADER_JS = 'const fs=require("fs");const [p,rock,ver,inst]=process.argv.slice(1);'
  + 'let t=fs.readFileSync(p,"utf8");'
  + 'const note="Yours to adapt. Updates arrive as offers from your rock and never overwrite without your OK.";'
  + 'const add=[["origin-rock",JSON.stringify(rock)],["origin-version",String(Number(ver)||0)],["installed",inst],["note",JSON.stringify(note)]];'
  + 'const m=t.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---[ \\t]*(?:\\r?\\n|$)/);'
  + 'let fm=m?m[1]:"";const fresh=[];'
  + 'for(const [k,v] of add){const re=new RegExp("^"+k+":.*$","m");const line=k+": "+v;'
  + 'if(re.test(fm))fm=fm.replace(re,line);else fresh.push(line)}'
  + 'fm=fresh.concat(fm?[fm]:[]).join("\\n");'
  + 'const body=m?t.slice(m[0].length):t;'
  + 'fs.writeFileSync(p,"---\\n"+fm+"\\n---\\n"+body)';

// The org brain's location is deployment-configurable. The resolution chain
// (staged deployment.yaml value > baked env > /state/brain > the box root
// itself, for a member-born rock) lives in ONE place now —
// engine/lib/brain-root.mjs — after five separate readers independently
// missed the member-born leg (finding 107; the full history is on the
// module). Every org verb resolves it fresh via this fragment, so a
// deployment that moves its brain keeps a working panel.
const BR_RESOLVE = BRAIN_ROOT_SH;
const BR_CD = BR_RESOLVE + 'cd "$BR" 2>/dev/null || { echo "ERROR: no org brain at $BR"; exit 1; }; '
  // The audience every verified handshake is checked against, handed to the rock
  // by the app that mints the tokens. It is the same installed-app client id
  // google-signin.mjs signs with, and it was never per-rock configuration.
  //
  // brain-template now defaults it too, but a rock CANNOT PULL its own brain
  // after the day it is born, so that fix alone reaches only rocks stamped from
  // here on. Every rock already standing would have stayed dormant: no join
  // request ever visible, no redeemed device ever appearing under Approve a
  // device, both while their screens said otherwise. Exporting it here reaches
  // them the moment their operator's app updates, and `:-` keeps any value the
  // rock sets for itself (an org bringing its own OAuth client) winning.
  + 'export AIOS_OAUTH_AUDIENCE="${AIOS_OAUTH_AUDIENCE:-'
  + '}"; ';

// The retire path the /demote route actually runs (merge 2026-08-04): prefer
// the mineral's own demote script, which retires the directory handle BEFORE
// flipping the tier (fix/live-cert), so a failure leaves an honest rock rather
// than a mineral the directory still routes to. An older mineral without the script
// falls back to the plain tier flip, exactly what this route always did.
// The public-brain verbs need the engine script the image ships (S9); a mineral on
// an older image gets a clear sentence, not a module-not-found stack trace.
const PUBBRAIN_GUARD = '[ -f /app/engine/ops/brain-public.mjs ] || '
  + '{ echo "ERROR: this mineral\'s software predates the public brain. It updates itself overnight; try tomorrow, or press Update & restart."; exit 1; }; ';

const DEMOTE_RUN = BR_RESOLVE
  + 'if [ -f /app/engine/promote/demote.mjs ]; then AIOS_BRAIN_ROOT="$BR" node /app/engine/promote/demote.mjs; else ' + DEMOTE_CMD + '; fi';

// A verb that runs a script out of the rock's OWN brain has to cope
// with a brain that predates the script: nothing pulls new machinery down on
// its own, so a brain seeded last month simply does not have this month's
// orchestrator. Without this the member sees node's own module-not-found
// stack trace printed into the org console (hit live evicting a member,
// 2026-08-04). push-ask and drop-membership already did this by hand; every
// caller now shares one guard so the next script cannot forget it.
// Sam's ruling at the T8 live cert (2026-08-10): a rock must not EXPOSE itself
// to the public while it cannot host — test-org-4 sat on the public board and
// accepted an anchor it could not deliver (no GitHub connected, so no channel
// repos), leaving a tie standing "wiring" forever. The check runs the SAME
// resolver adoption runs (env, .env, legacy names, staged provisioning, the
// box's connected account), so the gate and the machinery can never disagree;
// a brain from before the resolver falls back to the plain .env pair.
// GH_CONFIG_DIR IS PART OF THE QUESTION. The resolver's last rung is "the box's
// own connected GitHub", which it reads with `gh auth token` — and the in-app
// connect writes gh's config to /state/.kernel/gh, not gh's default path. This
// probe did not export it, so `gh auth token` looked in the wrong place, rung 4
// failed, and a rock with a perfectly good connected account was told forever
// that it had none. Live on harbour-labs 2026-08-11: the resolver answered
// {"ok":true,"owner":"cradsdavis-cell"} the moment GH_CONFIG_DIR was set, while
// the Pebbles page still read "Connect GitHub before you add your first member".
// org-github-routes.mjs already carries the lesson in a comment ("ONE definition
// of where gh's config lives... deriving it twice is how they came apart");
// this probe was the third reader and never got told.
const GH_HOSTING_CHECK =
  'if [ -f factory/org-github.mjs ]; then '
  + 'GH_CONFIG_DIR="${GH_CONFIG_DIR:-/state/.kernel/gh}" '
  + 'node --input-type=module -e \'const {resolveOrgGitHub}=await import(process.cwd()+"/factory/org-github.mjs");process.exit(resolveOrgGitHub({brainRoot:process.cwd()}).ok?0:1)\' '
  // THE REMEDY NAMED HERE WAS REMOVED FROM THE PRODUCT (fixed 2026-08-13).
  // Both sentences sent the owner to run `connect-github` in a terminal. That
  // hop was deliberately deleted on 2026-08-10, after Sam pressed the button
  // that used to do it and got the GitHub CLI's arrow-key picker: "pretty
  // intimidating for a non-technical user". Since then there has been a Connect
  // GitHub button on the Custody & backup card, and this error is raised on the
  // SAME PAGE as that button, two cards below it. Hit live on qa-r2-gmail while
  // saving the community listing.
  //
  // An error whose instruction is a shell command, in a product whose whole
  // point is that you do not need one, is the failure this repo keeps recording.
  // Point at the button that exists.
  + '|| { echo "ERROR: this rock has no GitHub account connected, so it cannot host members yet. Open Your rock and press Connect GitHub on the Custody and backup card, then try again. Nothing was changed."; exit 1; }; '
  + 'else '
  + '{ grep -qE "^ORG_GH_OWNER=." .env 2>/dev/null && grep -qE "^ORG_GH_TOKEN=." .env 2>/dev/null; } '
  + '|| { echo "ERROR: this rock has no GitHub identity, so it cannot host members yet. This rock needs its software updated first, then press Connect GitHub on the Custody and backup card. Nothing was changed."; exit 1; }; fi; ';

const needsBrainScript = (name, what) => `[ -f orchestrator/${name}.mjs ] || `
  + `{ echo "ERROR: this rock brain predates ${what} (no orchestrator/${name}.mjs). `
  + `Update the brain from the template, then try again."; exit 1; }; `;

// D49 onboarding gate: no member may be created until the rock's OWN 8-layer
// brain is onboarded (onboarding-state.json phase === "done"). An absent file
// (rock never ran /onboard) also blocks. Prepended to stamp-member after
// BR_RESOLVE (it reads "$BR").
const ONBOARD_GATE = 'node -e \'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.phase==="done"?0:1)\' "$BR/onboarding-state.json" 2>/dev/null '
  + '|| { echo "ERROR: finish onboarding this rock first, then members can be created. Open your rock in the Claude Code app (your rock connection in its Environment dropdown) and run /onboard; when it says it is done, come back here and add the member."; exit 1; }; ';

// ---------------------------------------------------------------- brain viewer
// Read-only wiki browser (D44), shared by both editions with a different entry:
// the org brain at its resolved brain_root (operators only), the member's own
// wiki at /state/wiki.
//
// SCOPE, 2026-08-17: no longer .md-only. Pages (.md), flat text (.txt/.csv/.tsv)
// and images (png/jpg/jpeg/gif/webp) are all listed and readable; see ASSET_EXT
// above for why that list is an allow-list and what it deliberately excludes.
// The secrecy boundary that ".md only" used to carry now lives in relArg().
//
// The org edition additionally scopes the LIST to the wiki proper (root-level
// pages + notes/ + decisions/ + wiki/): the brain repo also carries machinery
// dirs (registry/, control/, factory/, packs/, orchestrator/, templates/, tools/)
// whose stray files are not pages an operator should wade through.
// brain-read stays repo-wide (a wikilink may point outside the listed set).
// 6MB of real bytes, ~8MB once base64'd. Comfortably covers a scan, a diagram or
// a phone photo; refuses the 40MP raw that would wedge the channel.
const BRAIN_IMAGE_MAX = 6 * 1024 * 1024;
function brainVerbs(enter, opts = {}) {
  // `wiki` IS IN SCOPE (finding 107, 2026-08-13). box-cockpit.mjs was widened on
  // 2026-08-11 to walk <brain_root>/wiki because /onboard writes every layer to
  // wiki/_layers/ and every person to wiki/people/. That fix reached the GRAPH
  // and neither of the other two readers, so a fully onboarded rock drew a graph
  // of twelve pages next to a Files tree listing three, and Sharing offered only
  // the three template scaffold pages. One wiki, three readers, three answers.
  //
  // The find predicate is built FROM ASSET_EXT, not hand-written beside it. The
  // finding-107 lesson was one wiki with three readers giving three answers; a
  // second hard-coded extension list would be the same bug wearing a new hat.
  const namePred = ASSET_EXT.map((e) => `-name '*.${e}'`).join(' -o ');
  const listFind = opts.scope === 'wiki'
    ? `{ find . -maxdepth 1 \\( ${namePred} \\); for d in notes decisions insights wiki; do [ -d "$d" ] && find "$d" \\( ${namePred} \\); done; } | sed 's|^\\./||' | sort`
    : `find . \\( ${namePred} \\) -not -path './.git/*' -not -path './cockpit/*' | sed 's|^\\./||' | sort`;
  return {
    'brain-list': {
      build: () => ({ command: enter + listFind }),
    },
    // Text families only. An image sent down this verb would arrive as mojibake,
    // so imageArg/brain-image is a separate door rather than a flag on this one.
    'brain-read': {
      build: (a = {}) => {
        const page = textArg(a.page);
        return {
          command: enter + 'cat ' + shq(page, 'page') + ' 2>/dev/null || echo "ERROR: no such page: ' + page + '"',
        };
      },
    },
    // Images, base64 on ONE line, because /run is a line-based SSE channel.
    //
    // THE SIZE CAP IS LOAD-BEARING, not tidiness. base64 inflates by ~4/3 and the
    // whole payload becomes a single SSE frame held in memory in the panel server,
    // the browser and this process at once. An 80MB photo straight off a phone
    // would be a ~107MB line. The cap refuses IN WORDS the member can act on,
    // before `base64` ever runs, so the failure is a sentence and not a hang.
    'brain-image': {
      build: (a = {}) => {
        const page = imageArg(a.page);
        const q = shq(page, 'page');
        return {
          command: enter
            + `[ -f ${q} ] || { echo "ERROR: no such image: ${page}"; exit 1; }; `
            + `sz=$(wc -c < ${q}); `
            + `[ "$sz" -le ${BRAIN_IMAGE_MAX} ] || { echo "ERROR: this image is too large to preview in the app ($((sz/1024))KB; the limit is ${Math.round(BRAIN_IMAGE_MAX / 1024)}KB). Open it over a Claude Code connection instead."; exit 1; }; `
            + `echo "__IMAGE__ ${extOf(page)} $sz"; base64 -w0 ${q} 2>/dev/null || base64 ${q} | tr -d '\\n'`,
        };
      },
    },
  };
}
const memberBrainEnter = 'cd /state/wiki 2>/dev/null || { echo "ERROR: no brain at /state/wiki"; exit 1; }; ';

// ---------------------------------------------------------------- verb whitelist
// Everything the browser can run, and nothing else. build(args) returns
// { command, stdin? } or throws a 400. adminOnly verbs 403 for role=support;
// mutating verbs serialize (409 while one runs).
export const VERBS = {
  // Org brain viewer (D44): operators browse the rock's own wiki read-only,
  // scoped to the wiki proper (machinery dirs hidden).
  ...brainVerbs(BR_CD, { scope: 'wiki' }),

  // D52: is the rock's own 8-layer brain onboarded? Drives the panel's
  // "connect Claude Code and run /onboard" banner (the same signed-in-but-not-
  // onboarded surface members get). Read-only; absent file -> {}.
  'onboard-state': {
    build: () => ({ command: BR_RESOLVE + 'cat "$BR/onboarding-state.json" 2>/dev/null || echo "{}"' }),
  },

  // connectivity + role probe. AIOS_LOGIN is stamped into the container env by
  // enter-aios from the sshd-authenticated login user (D46), so the role the
  // panel displays is SERVER-derived from the login: aios-op = admin. (Support was
  // deleted 2026-08-05; aios-op is the only operator login.)
  // Empty on pre-D46 minerals (single-login), where the client fallback applies.
  whoami: {
    build: () => ({ command: 'echo "login=${AIOS_LOGIN:-} user=$(whoami)"' }),
  },

  // ---- People (D46): the org's operators, one git-tracked yaml each.
  // people-sync derives /state/ssh/<login>/authorized_keys, which the host
  // sshd serves per authentication attempt: add/revoke is instant.
  'people-list': {
    build: () => ({
      command: BR_RESOLVE + 'for f in "$BR"/people/*.yaml; do [ -f "$f" ] || continue; '
        + 'case "$f" in */_*) continue;; esac; echo "=== $f"; cat "$f"; done',
    }),
  },

  'people-add': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const name = shq(a.name, 'name', 80);
      const email = String(a.email ?? '');
      if (!EMAIL_RE.test(email)) bad('that email doesn’t look like a normal address. Expected something like jane@example.com');
      // The Support role was DELETED 2026-08-05 (Sam: "Delete the role"). It had a
      // privilege-escalation bug (the mineral ran any command a Support login sent, and
      // the only admin check was a string the app prepended client-side), and it had
      // never been granted to anyone: the sole `role: support` on disk was the blank
      // template. Refused explicitly rather than silently coerced, so an older app
      // still offering the choice gets told what happened instead of quietly making
      // someone an Admin.
      const role = String(a.role ?? 'admin');
      if (role === 'support') bad('the Support role has been removed. Add this person as an Admin, or do not add them.');
      if (role !== 'admin') bad('role must be Admin');
      const pubkey = pubkeyArg(a.pubkey);
      return {
        command: 'set -e; ' + BR_CD + 'f=people/' + slug + '.yaml; '
          + '[ ! -f "$f" ] || { echo "ERROR: a person with the short id \'' + slug + '\' already exists. Pick a different short id, or revoke the existing person first."; exit 1; }; '
          + 'mkdir -p people; { '
          + 'echo "name: "' + name + '; '
          + 'echo "email: \\"' + email + '\\""; '
          + 'echo "role: \\"' + role + '\\""; '
          + 'echo "status: \\"active\\""; '
          + 'echo "added: \\"$(date +%F)\\""; '
          + 'echo "revoked: \\"\\""; '
          + 'echo "pubkeys:"; echo \'  - "' + pubkey + '"\'; } > "$f"; '
          + 'node tools/people-sync.mjs .; git add people/; '
          + GIT_ID + ' commit -q -m "panel: person ' + slug + ' added (' + role + ')" || true; '
          + GIT_PUSH + '; echo "OK: ' + slug + ' can now sign in as ' + 'aios-op (Admin)' + '"',
      };
    },
  },

  'people-add-key': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const pubkey = pubkeyArg(a.pubkey);
      return {
        command: 'set -e; ' + BR_CD + 'f=people/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: no person ' + slug + '"; exit 1; }; '
          + 'echo \'  - "' + pubkey + '"\' >> "$f"; '
          + 'node tools/people-sync.mjs .; git add people/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' new device key" || true; '
          + GIT_PUSH + '; echo "OK: key added for ' + slug + '"',
      };
    },
  },

  'people-revoke': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      return {
        command: 'set -e; ' + BR_CD + 'f=people/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: no person ' + slug + '"; exit 1; }; '
          // Last-admin guard. The member side has had one since roster-cli.mjs:55
          // ("the last device that can open your mineral"); the operator side never
          // did. It is only advisory while a rock still carries the founder's
          // provisioning key in the host's ~aios-op/.ssh/authorized_keys, but it
          // becomes load-bearing the moment the roster is the ONLY door
          // (AuthorizedKeysFile none, seeded rocks): revoking the last active
          // Admin would then be an unrecoverable lockout, because these minerals
          // have no root SSH at all. Support people are not gated: revoking them
          // cannot lock anyone out of administration.
          + 'if grep -qE \'^role:[[:space:]]*"?admin"?\' "$f" && grep -qE \'^status:[[:space:]]*"?active"?\' "$f"; then '
          + 'others=0; for p in people/*.yaml; do [ -f "$p" ] || continue; '
          + 'case "$p" in */_*) continue;; esac; if [ "$p" = "$f" ]; then continue; fi; '
          + 'grep -qE \'^role:[[:space:]]*"?admin"?\' "$p" || continue; '
          + 'grep -qE \'^status:[[:space:]]*"?active"?\' "$p" || continue; others=$((others+1)); done; '
          + '[ "$others" -gt 0 ] || { echo "REFUSED: ' + slug + ' is the only active Admin, so revoking them would leave nobody able to administer this mineral. Add another Admin first, then revoke this one."; exit 1; }; fi; '
          + 'sed -i \'s|^status:.*|status: "revoked"|\' "$f"; '
          + 'sed -i "s|^revoked:.*|revoked: \\"$(date +%F)\\"|" "$f"; '
          + 'node tools/people-sync.mjs .; git add people/; '
          + GIT_ID + ' commit -q -m "panel: person ' + slug + ' revoked" || true; '
          + GIT_PUSH + '; echo "OK: ' + slug + ' revoked; their keys stop working on the next connection attempt"',
      };
    },
  },

  // Fleet: heartbeat cards come straight off the derived registry index
  'fleet-index': {
    build: () => ({ command: BR_RESOLVE + 'cat "$BR/registry/index.json" 2>/dev/null || echo "[]"' }),
  },

  // Members: the raw registry rows (template/_schema files excluded)
  // ---- E6.1/E6.2 · the minimum console (org seat) -------------------------------
  // console-state: ONE read emits the whole org plane as a marked JSON line.
  // The SIGHT MASK is structural for the org seat: this mineral holds only its own
  // plane, /run reaches only configured targets, and the panel login gates the
  // route; the API can only ever return what this seat may see. Rows are
  // normalized via the brain's own registry/normalize-row.mjs when the deployed
  // brain carries it (T1.1+), with a raw-fields fallback for older live brains
  // so the console never blanks on a pre-pointer rock.
  'console-state': {
    build: () => ({
      // SOFT_FACTORY_ENV: leave-reconcile / ask-answers-reconcile / ask-push-pending
      // read ORG_GH_* and exit "dormant (no org GH auth)" without them. Every
      // applier here is routed to /dev/null, so that dormancy was invisible: the
      // console claimed to run the whole applier chain and silently ran a subset.
      command: SOFT_FACTORY_ENV + BR_CD
        // The console read is the request fabric's cadence (2026-08-03 audit):
        // pull the directory inbox so answers land without needing a send, then
        // run EVERY applier so an accepted request actually executes. All
        // fail-soft, all idempotent (applied-ledger), same on-demand pattern
        // join-requests uses for join-reconcile. Wiring all five is Sam's
        // ruling from the verb interview (spec 2026-08-03): transfer moves the
        // pointer, re-anchor moves the row + swaps channels, rejoin revives a
        // left row, permission lands recorded grants, reframe delivers or
        // pends the imprint.
        + '{ [ -f control/requests-reconcile.mjs ] && node control/requests-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/transfer-reconcile.mjs ] && node control/transfer-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/re-anchor-reconcile.mjs ] && node control/re-anchor-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/rejoin-reconcile.mjs ] && node control/rejoin-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/permission-reconcile.mjs ] && node control/permission-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/reframe-reconcile.mjs ] && node control/reframe-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/ask-answers-reconcile.mjs ] && node control/ask-answers-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/ask-push-pending.mjs ] && node control/ask-push-pending.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/leave-reconcile.mjs ] && node control/leave-reconcile.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/late-attach-reconcile.mjs ] && node control/late-attach-reconcile.mjs >/dev/null 2>&1; } || true; '
        // E6.5: the PLATFORM seat rides the operator credential. Only a mineral
        // whose .env holds CREATE_PULL_TOKEN (Sam's crads root) can pull
        // /platform-totals; every other org gets an empty PLATFORM_STATE and
        // no chip. Counts only (pointers-only): orgs, edges, open requests.
        + 'PTOK="$(grep -E "^CREATE_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
        + 'PDIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; PDIR="${PDIR:-https://directory.crads-ai.com}"; '
        + 'PLAT="{}"; if [ -n "$PTOK" ]; then PLAT="$(curl -s -m 6 -H "authorization: Bearer $PTOK" "$PDIR/platform-totals" 2>/dev/null || echo "{}")"; fi; '
        + 'export PLAT; '
        // A6 handover asks (verb-interview ruling 2026-08-03): the ask used to
        // land at the directory and the rock was expected to just know. Pulled
        // here with the org token so the console can show it as a Requests card.
        + 'OTOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
        + 'ORGN="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
        + 'HODIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; HODIR="${HODIR:-https://directory.crads-ai.com}"; '
        + 'HANDOVER="{}"; if [ -n "$OTOK" ] && [ -n "$ORGN" ]; then HANDOVER="$(curl -s -m 6 -H "authorization: Bearer $OTOK" "$HODIR/handover-requests?org=$ORGN" 2>/dev/null || echo "{}")"; fi; '
        + 'export HANDOVER; '
        // Rock ties (2026-08-05 + 2026-08-09): pending tie asks + the live tie
        // list ride the same console read, same org token. The directory is the
        // SOLE source for both: a joined or anchored pebble was never stamped
        // by this rock and has no registry row here.
        + 'TIEREQ="{}"; if [ -n "$OTOK" ] && [ -n "$ORGN" ]; then TIEREQ="$(curl -s -m 6 -H "authorization: Bearer $OTOK" "$HODIR/rock-tie-requests?org=$ORGN" 2>/dev/null || echo "{}")"; fi; '
        + 'export TIEREQ; '
        + 'TIES="{}"; if [ -n "$OTOK" ] && [ -n "$ORGN" ]; then TIES="$(curl -s -m 6 -H "authorization: Bearer $OTOK" "$HODIR/rock-ties?org=$ORGN" 2>/dev/null || echo "{}")"; fi; '
        + 'export TIES; '
        // What each pebble calls ITSELF (2026-08-16, docs/naming.md). The registry
        // row carries the name the ADMIN typed at stamp time and nothing has ever
        // carried a member's own rename back to it, so the Pebbles page has been
        // showing a name its owner may have replaced weeks ago. Same org token,
        // same round, one more curl.
        + 'PNAMES="{}"; if [ -n "$OTOK" ] && [ -n "$ORGN" ]; then PNAMES="$(curl -s -m 6 -H "authorization: Bearer $OTOK" "$HODIR/rock-pebble-names?org=$ORGN" 2>/dev/null || echo "{}")"; fi; '
        + 'export PNAMES; '
        + 'node -e \''
        + 'const fs=require("fs"),path=require("path");'
        + 'const pol=(()=>{try{return fs.readFileSync("org-policy.yaml","utf8")}catch{return ""}})();'
        + 'const org=(pol.match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m)||[])[1]?.trim()||"";'
        + 'const disp=(pol.match(/^\\s{2}display_name:\\s*"?([^"\\n#]*)"?/m)||[])[1]?.trim()||org;'
        + 'const load=async()=>{try{return await import(path.resolve("registry/normalize-row.mjs"))}catch{return null}};'
        + 'load().then((mod)=>{'
        + 'const minerals=[];'
        + 'let files=[];try{files=fs.readdirSync("registry/members").filter((f)=>f.endsWith(".yaml")&&!f.startsWith("_"))}catch{}'
        + 'for(const f of files){const y=fs.readFileSync(path.join("registry/members",f),"utf8");'
        + 'if(mod){const n=mod.normalizeRow(mod.extractRow(y),{anchorSlug:org});minerals.push({...n,slug:n.slug||f.replace(/\\.yaml$/,""),problems:mod.validateRow(n)})}'
        + 'else{const q=String.fromCharCode(34);const g=(k)=>(y.match(new RegExp("^"+k+":\\\\s*"+q+"?([^"+q+"\\\\n#]*)"+q+"?","m"))||[])[1]?.trim()||"";'
        + 'minerals.push({slug:g("slug")||f.replace(/\\.yaml$/,""),status:g("status")||"active",owner:g("owner")||"member",managed_by:g("managed_by")||"org",anchor:g("anchor")||org,memberships:[g("anchor")||org],tier:"pebble",legacy_level:g("tier"),problems:["pre-pointer brain: normalize-row.mjs missing, raw fallback"]})}}'
        + 'const finish=(value)=>{let requests=[];try{requests=JSON.parse(fs.readFileSync("control/org-requests.json","utf8")).requests||[]}catch{}'
        + 'let platform=null;try{const p2=JSON.parse(process.env.PLAT||"{}");if(p2.orgs!==undefined)platform=p2}catch{}'
        + 'let handover=[];try{const h2=JSON.parse(process.env.HANDOVER||"{}");if(Array.isArray(h2.requests))handover=h2.requests}catch{}'
        + 'let rockRequests=[];try{const c2=JSON.parse(process.env.TIEREQ||"{}");if(Array.isArray(c2.requests))rockRequests=c2.requests}catch{}'
        + 'let rockTies=[];try{const a2=JSON.parse(process.env.TIES||"{}");if(Array.isArray(a2.ties))rockTies=a2.ties}catch{}'
        + 'let pebbleNames=[];try{const p3=JSON.parse(process.env.PNAMES||"{}");if(Array.isArray(p3.pebbles))pebbleNames=p3.pebbles}catch{}'
        + 'console.log("CONSOLE_STATE "+JSON.stringify({org,display:disp,minerals,requests,handover,rockRequests,rockTies,pebbleNames,value,platform,generated:new Date().toISOString()}))};'
        + 'import(path.resolve("registry/value.mjs")).then(async(v)=>{'
        + 'minerals.forEach((b)=>{b.seat=v.boxSeatLine(b,{anchorSlug:org})});'
        + 'try{const acc=await import(path.resolve("registry/access.mjs"));minerals.forEach((b)=>{b.access=acc.reachesFor(b,{anchorSlug:org})})}catch{}'
        + 'finish({ledger:v.orgLedger(minerals,{anchorSlug:org}),totals:v.fleetTotals(minerals,{anchorSlug:org})})'
        + '}).catch(()=>finish(null))'
        + '})\'',
    }),
  },
  // console-answer: answer a consent request from the org seat. The directory
  // call runs ON the mineral with the box-held ORG_PULL_TOKEN (the credential never
  // reaches the browser); requests-reconcile picks up the state change on its
  // next pass. Admin-gated: answering consent is an authority act.
  'console-answer': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[0-9a-f]{8,32}$/.test(id)) bad('that request id does not look right (expected the id shown on the request card)');
      const answer = String(a.answer ?? '');
      if (answer !== 'accepted' && answer !== 'declined') bad('answer must be accepted or declined');
      const note = String(a.note ?? '').trim();
      if (note.length > 240) bad('the note is too long (240 characters is plenty for a consent note)');
      // Control characters only. Quotes and backslashes were refused solely
      // because the note used to be pasted into a shell-quoted JSON body; it is
      // now built by node from argv (below), so an operator can write a normal
      // sentence with an apostrophe or a quote in it.
      if (/[\x00-\x1f\x7f]/.test(note)) bad('the note cannot contain control characters');
      return {
        command: BR_CD
          + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$TOK" ] || { echo "ERROR: this rock has no directory token (ORG_PULL_TOKEN missing from the brain .env)"; exit 1; }; '
          + 'ORG="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\')"; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          // The BODY is built by node from argv, not assembled in the shell. It
          // used to be a double-quoted -d "...\"note\":\"<note>\"...", so a note
          // of `see $(cat /state/secrets/provisioning.env.local | curl ...)` was
          // evaluated on the mineral and the org's Hetzner, Cloudflare and GitHub
          // tokens left with the answer. Its sibling console-request already did
          // it this way; console-answer was the one that assembled JSON in shell.
          + 'NOTE=' + (note ? shq(note, 'note', 240) : "''") + '; '
          + 'BODY="$(node -e \'process.stdout.write(JSON.stringify({org:process.argv[1],id:process.argv[2],answer:process.argv[3],'
          + '...(process.argv[4]?{note:process.argv[4]}:{})}))\' "$ORG" \'' + id + '\' \'' + answer + '\' "$NOTE")"; '
          + 'CODE="$(curl -s -o /tmp/console-answer.out -w "%{http_code}" -X POST "$DIR/requests-answer" '
          + '-H "authorization: Bearer $TOK" -H "content-type: application/json" '
          + '--data-binary "$BODY")"; '
          + 'cat /tmp/console-answer.out; echo; '
          + '[ "$CODE" = "200" ] || { echo "ERROR: the directory said $CODE"; exit 1; }; '
          + 'node control/requests-reconcile.mjs 2>/dev/null || true; '
          + 'echo "OK: request ' + id.slice(0, 8) + '\u2026 ' + answer + '."',
      };
    },
  },
  // Two-tier join (ruling 2026-08-05): the org card's read. Pending asks +
  // live affiliations in one marked line, straight from the directory \u2014 the
  // SOLE source for affiliation state, since an affiliated pebble was never
  // stamped by this rock and has no registry row here. adminOnly for the same
  // reason join-requests is: an empty answer to Support would read as "nobody
  // is waiting" when the truth is "you may not look".
  'rock-state': {
    adminOnly: true,
    build: () => ({
      command: BR_CD
        + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
        + 'ORGN="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
        + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
        + 'if [ -z "$TOK" ] || [ -z "$ORGN" ]; then echo \'ROCK_STATE {"requests":[],"ties":[],"dormant":"this rock has no directory token or org name, so it cannot see tie asks"}\'; exit 0; fi; '
        + 'REQS="$(curl -s -m 6 -H "authorization: Bearer $TOK" "$DIR/rock-tie-requests?org=$ORGN" 2>/dev/null || echo "{}")"; '
        + 'TIES2="$(curl -s -m 6 -H "authorization: Bearer $TOK" "$DIR/rock-ties?org=$ORGN" 2>/dev/null || echo "{}")"; '
        + 'export REQS TIES2; '
        + 'node -e \'let r={},a={};try{r=JSON.parse(process.env.REQS||"{}")}catch{};try{a=JSON.parse(process.env.TIES2||"{}")}catch{};'
        + 'const dormant=(Array.isArray(r.requests)||Array.isArray(a.ties))?undefined:"the directory did not answer just now";'
        + 'console.log("ROCK_STATE "+JSON.stringify({requests:Array.isArray(r.requests)?r.requests:[],ties:Array.isArray(a.ties)?a.ties:[],...(dormant?{dormant}:{})}))\'',
    }),
  },
  // Two-tier join (ruling 2026-08-05): answer a pebble's ASK TO JOIN this
  // community. Affiliation only \u2014 no custody, no hosting, no anchor change \u2014
  // so unlike the A6 handover there is no box-side accept step: the directory
  // edge IS the tie, and the member's own bill is untouched.
  'rock-answer': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[0-9a-f]{8,40}$/.test(id)) bad('that request id does not look right (expected the id shown on the request card)');
      const decision = String(a.decision ?? '');
      if (decision !== 'accept' && decision !== 'reject') bad('decision must be accept or reject');
      const tie = String(a.tie ?? '');
      if (tie && tie !== 'joined' && tie !== 'anchored') bad('tie must be joined or anchored when given');
      return {
        command: BR_CD
          // Sam's ruling (T8 cert): an ANCHOR is refused BEFORE the directory
          // writes the edge when this rock cannot host — a half-state (tie
          // standing, member forever "wiring") must never form. The ask stays
          // pending; connect-github and approve again. The page passes the tie
          // kind; an older page omitting it falls back to the post-accept WARN.
          + (decision === 'accept' && tie === 'anchored' ? GH_HOSTING_CHECK : '')
          + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$TOK" ] || { echo "ERROR: this rock has no directory token (ORG_PULL_TOKEN missing from the brain .env)"; exit 1; }; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          + 'BODY="$(node -e \'process.stdout.write(JSON.stringify({id:process.argv[1],decision:process.argv[2]}))\' \'' + id + '\' \'' + decision + '\')"; '
          + 'CODE="$(curl -s -o /tmp/rock-answer.out -w "%{http_code}" -X POST "$DIR/rock-tie-result" '
          + '-H "authorization: Bearer $TOK" -H "content-type: application/json" '
          + '--data-binary "$BODY")"; '
          + 'cat /tmp/rock-answer.out; echo; '
          + '[ "$CODE" = "200" ] || { echo "ERROR: the directory said $CODE"; exit 1; }; '
          // T6: an accepted ANCHOR is adopted on the spot \u2014 registry seat,
          // channel repos, staged wire \u2014 so the app-made anchor ends where a
          // rock-created member ends. The directory hands back tie+slug+email
          // on exactly this accept (T1); joined accepts skip all of it.
          + 'if node -e \'const d=JSON.parse(require("fs").readFileSync("/tmp/rock-answer.out","utf8"));process.exit(d.decision==="accept"&&d.tie==="anchored"?0:1)\' 2>/dev/null; then '
          + 'if [ -f orchestrator/anchor-adopt.mjs ]; then '
          + 'node orchestrator/anchor-adopt.mjs --result /tmp/rock-answer.out || echo "WARN: the tie stands but adoption staging failed; run the reconcile again or re-answer"; '
          + 'else echo "WARN: this rock brain predates anchor adoption (no orchestrator/anchor-adopt.mjs). Update the brain from the template; the tie stands but the mineral is not wired."; fi; '
          + 'fi; '
          + 'echo "OK: tie ask ' + id.slice(0, 8) + '\u2026 ' + decision + 'ed."',
      };
    },
  },
  // Evict shape (ruling 2026-08-09): a community MAY end an affiliation it
  // approved, but never silently \u2014 the reason is required here, enforced again
  // by the directory (400 without one), stored, and SHOWN to the person on
  // their own Communities page. Mirrors evict-member's reason discipline.
  // membership-drop (T2.7, the mineral owner's verb) is deliberately not used:
  // an affiliated pebble has no registry row on this rock to drop.
  'rock-tie-end': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const e = String(a.e ?? '');
      if (!/^[0-9a-f]{64}$/.test(e)) bad('e must be the member hash shown on the tie row');
      const tie = String(a.tie ?? '');
      if (tie !== 'joined' && tie !== 'anchored') bad('tie must be joined or anchored');
      // WHICH MINERAL'S TIE (2026-08-16, finding 152's sibling, and the worst of
      // the three). The hash names a PERSON, and a person may hold two pebbles
      // on this rock, so the directory sorted and ended whichever was newest:
      // one member's other pebble could be cut off its host and its billing by
      // an eviction it had nothing to do with, and the notice they read would
      // give a reason for a tie that still stands. The rock has the slug on
      // every row of /rock-ties, which is where the End-tie button is drawn
      // from, so it says which. Optional here only so a console that predates
      // the change still ends a lone tie; two ties and no slug the directory
      // refuses outright.
      const slug = String(a.slug ?? '');
      if (slug && !MINERAL_RE.test(slug)) bad('slug must be the mineral name shown on the tie row');
      const reason = String(a.reason ?? '').trim();
      if (!reason) bad('a reason is required: it is shown to the person (who ended the tie and why) \u2014 never a silent cut');
      const rsn = shq(reason, 'reason', 160);
      return {
        command: BR_CD
          + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$TOK" ] || { echo "ERROR: this rock has no directory token (ORG_PULL_TOKEN missing from the brain .env)"; exit 1; }; '
          + 'ORG="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\')"; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          + 'RSN=' + rsn + '; '
          + 'BODY="$(node -e \'const b={org:process.argv[1],e:process.argv[2],tie:process.argv[3],reason:process.argv[4]};if(process.argv[5])b.slug=process.argv[5];process.stdout.write(JSON.stringify(b))\' "$ORG" \'' + e + '\' \'' + tie + '\' "$RSN" \'' + slug + '\')"; '
          + 'CODE="$(curl -s -o /tmp/rock-tie-end.out -w "%{http_code}" -X POST "$DIR/rock-tie-end" '
          + '-H "authorization: Bearer $TOK" -H "content-type: application/json" '
          + '--data-binary "$BODY")"; '
          + 'cat /tmp/rock-tie-end.out; echo; '
          + '[ "$CODE" = "200" ] || { echo "ERROR: the directory said $CODE"; exit 1; }; '
          + 'echo "OK: tie ended, and they will see why."',
      };
    },
  },

  // ---- E6.3 · console verbs wired to the choreography ---------------------------
  // console-request: INITIATE a two-consent move from the org seat. The kinds
  // are the ruled taxonomy; every field is server-checked here and the body is
  // built by node ON the mineral (no shell-quoting of user text into curl), sent
  // with the box-held ORG_PULL_TOKEN. The directory re-validates everything
  // again (auth, enums, bounds, cycle guards): defense in depth, not trust.
  'console-request': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const KINDS = ['late-attach', 're-anchor', 'transfer', 'rejoin', 'ask-read', 'ask-install', 'reframe', 'self-run'];
      const kind = String(a.kind ?? '');
      if (!KINDS.includes(kind)) bad(`kind must be one of ${KINDS.join(' / ')}`);
      const toOrg = String(a.to_org ?? '');
      if (!ORG_RE.test(toOrg)) bad('to_org must be the receiving rock\u2019s handle (lowercase letters, numbers, hyphens)');
      const subject = String(a.subject ?? '').trim();
      // $ ( ) and backtick were permitted here, and the confirmation echoes below
      // are double-quoted shell strings, so a subject could substitute a command
      // inside the rock's rock container (which holds its Hetzner,
      // Cloudflare and GitHub tokens). Both halves are closed: refused here, and
      // the echoes no longer interpolate into double quotes.
      if (!subject || subject.length > 120 || /[\x00-\x1f'"\\$`()]/.test(subject)) bad('subject must be short (120 chars), with no quotes, backslashes, brackets or $ and backtick characters; usually the mineral\u2019s short username');
      // PATH CONTAINMENT (2026-08-20 audit). For kind 're-anchor' the subject is
      // interpolated into readFileSync("registry/members/<subject>.yaml"), and it
      // is the one such interpolation in this file that never passed through
      // slugArg. The character class above forbids quotes, backslash, dollar,
      // backtick and brackets, so nothing can break out of the JS string or the
      // shell line, but it permits '/' and '.', so a subject of '../../org-policy'
      // read outside registry/members/. The reachable harm is small, since the
      // exporter copies an eight-key whitelist out of a regex-grepped row so no
      // file content leaves the box, and this verb is adminOnly. But the read is
      // still one the caller chose, and containment must not depend on what the
      // consumer happens to do with the result. A re-anchor subject IS a mineral
      // slug, so hold it to the mineral slug rule the directory uses.
      if (kind === 're-anchor' && !MINERAL_RE.test(subject)) {
        bad('for a re-anchor, subject must be the mineral short username: 2 to 40 characters, lowercase letters, numbers and hyphens, not starting or ending with a hyphen');
      }
      const role = a.role === undefined ? '' : String(a.role);
      if (role && role !== 'applicant' && role !== 'inviter') bad('role must be applicant or inviter (late-attach only)');
      let payload = null;
      if (kind === 'reframe') {
        const fw = String(a.framework ?? '').trim();
        // Deliberately NOT tightened alongside `subject`. A framework name is prose
        // ("GROW (coaching model)"), and unlike subject it only ever lands inside
        // JSON.stringify(payload) within a single-quoted `node -e` script, where
        // $ ( ) and backtick are inert. Refusing them here bought no safety and
        // broke legitimate names, including re-sending an already-stored request.
        if (!fw || fw.length > 80 || /[\x00-\x1f'"\\]/.test(fw)) bad('a reframe offer names the framework (short, no quotes)');
        const intensity = String(a.intensity ?? 'overlay');
        if (!['overlay', 'integrate', 'rebuild'].includes(intensity)) bad('intensity must be overlay, integrate or rebuild');
        payload = { framework: fw, intensity };
      }
      return {
        command: 'set -e; ' + BR_CD
          + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$TOK" ] || { echo "ERROR: this rock has no directory token (ORG_PULL_TOKEN missing from the brain .env)"; exit 1; }; '
          + 'ORG="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\')"; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          // A re-anchor MUST carry the row, or the receiving rock has nothing to
          // land. Nothing produced this payload: exportRowForReAnchor existed but
          // was referenced only by its own tests, and console-request attached a
          // payload for 'reframe' alone. So an accepted re-anchor left the sender
          // marking the member as moved while the receiver's importReAnchoredRow
          // threw "bad slug in re-anchor payload" on {} every tick, forever: the
          // member belonged to nobody. Exported HERE, on the box that holds the
          // row, through the same governed-field exporter the importer expects.
          + (kind === 're-anchor'
            ? 'ROWJSON="$(node -e \'import("./registry/re-anchor.mjs").then(async(m)=>{'
              + 'const fs=require("fs");const nr=await import("./registry/normalize-row.mjs");'
              + 'const y=fs.readFileSync("registry/members/' + subject + '.yaml","utf8");'
              + 'process.stdout.write(JSON.stringify(m.exportRowForReAnchor(nr.extractRow(y),{anchorSlug:process.argv[1]})))})\' "$ORG" 2>/dev/null)"; '
              + '[ -n "$ROWJSON" ] || { echo ' + "'ERROR: could not read the registry row for " + subject + "; a re-anchor must carry it.'" + '; exit 1; }; '
            : '')
          + 'BODY="$(node -e \'const extra=process.argv[2]?{payload:JSON.parse(process.argv[2])}:{};'
          + 'console.log(JSON.stringify({from_org:process.argv[1],to_org:"' + toOrg + '",kind:"' + kind + '",subject:"' + subject + '"'
          + (role ? ',role:"' + role + '"' : '')
          + (payload ? ',payload:' + JSON.stringify(payload) : '')
          + ',...extra}))\' "$ORG" ' + (kind === 're-anchor' ? '"$ROWJSON"' : '""') + ')"; '
          + 'CODE="$(curl -s -o /tmp/console-req.out -w "%{http_code}" -X POST "$DIR/requests" '
          + '-H "authorization: Bearer $TOK" -H "content-type: application/json" -d "$BODY")"; '
          + 'cat /tmp/console-req.out; echo; '
          + '[ "$CODE" = "200" ] || { echo "ERROR: the directory said $CODE"; exit 1; }; '
          + 'node control/requests-reconcile.mjs 2>/dev/null || true; '
          + "echo 'OK: " + kind + ' request sent to ' + toOrg + ' re ' + subject + ".'",
      };
    },
  },
  // console-withdraw: the sender takes an open request back (T2.1's withdraw).
  'console-withdraw': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[0-9a-f]{8,32}$/.test(id)) bad('that request id does not look right');
      return {
        command: 'set -e; ' + BR_CD
          + 'TOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$TOK" ] || { echo "ERROR: no directory token (ORG_PULL_TOKEN)"; exit 1; }; '
          + 'ORG="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\')"; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          + 'CODE="$(curl -s -o /tmp/console-wd.out -w "%{http_code}" -X POST "$DIR/requests-withdraw" '
          + '-H "authorization: Bearer $TOK" -H "content-type: application/json" '
          + '-d "{\\"org\\":\\"$ORG\\",\\"id\\":\\"' + id + '\\"}")"; '
          + 'cat /tmp/console-wd.out; echo; '
          + '[ "$CODE" = "200" ] || { echo "ERROR: the directory said $CODE"; exit 1; }; '
          + 'node control/requests-reconcile.mjs 2>/dev/null || true; '
          + 'echo "OK: request withdrawn."',
      };
    },
  },
  // 'console-delivery' was DELETED 2026-08-10 with the pause concept (Sam's
  // pebble-audit ruling 3: "I don't think we need a Pause option at all").
  // brain-template's push-down still honours delivery_pause on a row; with the
  // setter gone, any row already carrying delivery_pause: "true" stays paused
  // until the flag is cleared by hand or push-down stops reading it (flagged in
  // docs/superpowers/specs/2026-08-10-pebbles-hardening.md).

  // Slice 2 (pebble agency, 2026-08-03): the member lane's ASK. A permission
  // question or framework offer to a MEMBER-OWNED box rides the box's inbox
  // (push-ask.mjs); the person answers in their console and the answer comes
  // back up the heartbeat on the next console read (ask-answers-reconcile).
  'ask-push': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const kind = String(a.kind ?? '');
      if (!['ask-read', 'ask-install', 'reframe'].includes(kind)) bad('kind must be ask-read, ask-install or reframe');
      let extra = '';
      if (kind === 'reframe') {
        const fw = String(a.framework ?? '').trim();
        if (!fw || fw.length > 80 || /[\x00-\x1f'"\\|]/.test(fw)) bad('a reframe offer names the framework (short, no quotes)');
        const intensity = String(a.intensity ?? 'overlay');
        if (!['overlay', 'integrate', 'rebuild'].includes(intensity)) bad('intensity must be overlay, integrate or rebuild');
        extra = " --framework '" + fw + "' --intensity " + intensity;
      }
      if (a.withdraw === true || a.withdraw === 'true') extra += ' --withdraw';
      return {
        // FACTORY_ENV, not bare BR_CD: push-ask writes to the member's inbox
        // repo, so it needs the org's GitHub credentials from
        // /state/secrets/provisioning.env.local exactly like transfer-invite
        // does. Without it the verb died "ORG_GH_OWNER + ORG_GH_TOKEN required
        // (.env)" on the first live firing (2026-08-03 cert), because the
        // brain's own .env carries no org token.
        command: 'set -e; ' + FACTORY_ENV + ORG_GH_REQUIRED + BR_CD
          + '[ -f orchestrator/push-ask.mjs ] || { echo "ERROR: this rock brain predates the ask channel (no orchestrator/push-ask.mjs). Update the brain from the template, then try again."; exit 1; }; ' + 'node orchestrator/push-ask.mjs ' + slug + ' ' + kind + extra,
      };
    },
  },

  // The T2.7 residual, built 2026-08-03: end ONE community tie and keep the
  // rest. Sam's ruling: this is the MINERAL OWNER's verb alone, a community cannot
  // expel, so it is admin-gated on the rock that holds the row and refuses the
  // anchor (a home ends by re-anchor or by leaving).
  'membership-drop': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const org = String(a.org ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(org)) bad('name the community to leave by its rock handle');
      return {
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + '[ -f orchestrator/drop-membership.mjs ] || { echo "ERROR: this rock brain predates community ties (no orchestrator/drop-membership.mjs). Update the brain from the template, then try again."; exit 1; }; ' + 'node orchestrator/drop-membership.mjs ' + slug + ' ' + org,
      };
    },
  },

  // Evict (Mountain model, 2026-08-04): the anchor tie ends FOR CAUSE. Differs
  // from member-revoke in what the person sees: the reason is REQUIRED and is
  // DELIVERED to their box before the row closes (the orchestrator enforces
  // that order — an eviction the person never hears about is not an eviction).
  // Nothing is destroyed: the box runs on, re-anchored to the Mountain, and
  // its hosted-seat bill moves off this rock at the next reflect.
  'evict-member': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (!String(a.reason ?? '').trim()) bad('a reason is required: it is shown to the person (who ended the tie and why) — never a silent cut');
      const reason = shq(a.reason, 'reason', 160);
      return { command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + needsBrainScript('evict-member', 'ending a membership for cause') + 'node orchestrator/evict-member.mjs ' + slug + ' --reason ' + reason };
    },
  },
  'member-list': {
    build: () => ({
      command: BR_RESOLVE + 'for f in "$BR"/registry/members/*.yaml; do [ -f "$f" ] || continue; '
        + 'case "$f" in */_*) continue;; esac; echo "=== $f"; cat "$f"; done',
    }),
  },

  // resume / bring-back: write status active in the member yaml, rebuild the
  // index, commit+push, restore the door key. PAUSE WAS REMOVED 2026-08-10
  // (Sam's pebble-audit ruling 3: no Pause at all — a rock does not lock a
  // member out of their own box; ending the relationship goes through leave,
  // evict or teardown, each of which says what it is). The verb survives for
  // the RESUME half only, so "Bring back" keeps working and rows paused before
  // the removal can still be released.
  'member-set-status': {
    // adminOnly (2026-07-24 P5 review): resume restores the approved door keys,
    // a real door operation, so it stays admin-gated like every sibling door
    // verb (member-revoke/leave/deprovision). Otherwise a support operator
    // could re-grant SSH access, including reactivating a member an admin
    // terminated.
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const status = String(a.status ?? '');
      if (status !== 'active') bad('status must be active (pause was removed 2026-08-10: a rock does not lock a member out of their box; end the tie instead)');
      // Legacy rows paused before the removal may still carry a paused_reason;
      // releasing the row clears it, same argv-not-sed shape the pause writer
      // used (an apostrophe in operator text must never re-parse as shell).
      const stampReason = "R=''; "
        + 'node -e \'const fs=require("fs");const p=process.argv[1];const r=process.argv[2];'
        + 'const line="paused_reason: "+JSON.stringify(r);let t=fs.readFileSync(p,"utf8");'
        + 't=/^paused_reason:/m.test(t)?t.replace(/^paused_reason:.*$/m,line)'
        + ':t+(t.endsWith("\\n")?"":"\\n")+line+"\\n";fs.writeFileSync(p,t)\' "$f" "$R"; ';
      return {
        // SOFT_FACTORY_ENV: push-member-key.mjs below is what actually opens and
        // shuts the member's door, and it hard-exits 2 without ORG_GH_*. On a
        // factory-provisioned rock those live ONLY in provisioning.env.local,
        // never in the brain's .env. Without this prefix Pause flipped the row,
        // printed "door shut, mineral kept", and left the member's SSH key installed.
        // Proven live 2026-08-04: after pausing, the member box still accepted a
        // connection and its own org-sync logged "member device keys installed: 1".
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'. Check the exact short username on the Fleet health tab."; exit 1; }; '
          + 'sed -i \'s|^status:.*|status: "active"|\' "$f"; '
          + stampReason
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' status -> active" || echo "(no change to commit)"; '
          + GIT_PUSH + '; '
          // D58 P5: restoring a member is a real door operation. push-member-key
          // delivers the approved keys when the row is active. Then reflect the
          // edge's new status. Both fail-soft so a restored member is never
          // left half-done.
          + needsBrainScript('push-member-key', 'door-key management') + 'node orchestrator/push-member-key.mjs ' + slug + ' || echo "WARN: the door key did NOT change on the mineral (the org GitHub credentials were unreachable). The registry and the mineral disagree until that is fixed."; '
          + '{ [ -f control/edges-reflect.mjs ] && node control/edges-reflect.mjs >/dev/null 2>&1; } || true; '
          + 'echo "OK: ' + slug + ' -> active (door restored)"',
      };
    },
  },

  // R6 (panel iteration 2, 2026-08-23): Forget an Ended member. The row moves
  // to registry/archive/<slug>.<date>.yaml and the card drops. Refused unless
  // the row's status is `left`: a row that is still active, or one the leave
  // reconcile has not yet flipped, is not the rock's to file away. Archive,
  // never delete: the row is the only record the rock keeps of the tie.
  // build-index.mjs rebuilds index.json + index.md from what is left.
  'member-forget': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      return {
        // BR_CD before set -e: the root probe exits non-zero where
        // deployment.yaml is absent (a brain that predates the 17 Aug stamp),
        // and under set -e that would kill the verb before its first word.
        command: BR_CD + 'set -e; f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'st="$(sed -n \'s/^status:[[:space:]]*"\\{0,1\\}\\([a-z]*\\)"\\{0,1\\}.*/\\1/p\' "$f" | head -1)"; '
          + '[ "$st" = left ] || { echo "ERROR: ' + slug + ' has not ended (status: ${st:-unknown}). Only a member whose tie has ended can be forgotten."; exit 1; }; '
          + 'mkdir -p registry/archive; d="$(date -u +%Y-%m-%d)"; t="registry/archive/' + slug + '.$d.yaml"; '
          + 'git mv -f "$f" "$t" 2>/dev/null || mv -f "$f" "$t"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: forget ' + slug + '" || echo "(no change to commit)"; '
          + GIT_PUSH + '; '
          + 'echo "OK: ' + slug + ' forgotten. The row is archived at $t."',
      };
    },
  },

  // 'stamp-member' was DELETED 2026-08-10 (pebble-audit ruling 10: the invite
  // link is the ONLY birth path). It was the verb that installed a
  // caller-supplied SSH key at birth — the exact shape of the 2026-07-28 F1
  // CRITICAL (it shipped without adminOnly once already) — and the UI chose it
  // silently whenever a hidden Advanced field was non-empty. invite-member
  // (stamp-pebble --invite-pending) carries everything else it did, including
  // the T3.1 ownership choice; a technical member enrols through the same link.


  // ---- Invites (D51): admin-first invite + two-party device approval. ------------
  // invite-member stamps an invite-pending box (no working key) and the factory echoes
  // a copyable, self-describing invite link the admin sends ("you send the link"). The
  // member redeems it in the app and reads a 6-char safety code; the admin confirms that
  // code here. approve-device RE-COMPUTES the code from the pasted key BEFORE any command
  // runs, so a tampered/substituted key produces a different code and is refused (this is
  // the graft that closes the leaked-bearer-link takeover every design's red-team found).
  // On approval the key is appended + the box flips active + push-member-key installs it.
  // member-revoke flips left + pushes an EMPTY key file = the door drops on the next sync.
  // Is this rock's factory armed, and if not, what exactly is missing? A READ:
  // creates nothing, spends nothing, prints no credential. It exists because the
  // answer used to be discoverable only by attempting a stamp and reading a raw
  // shell guard (2026-08-10, test-org-4), one missing credential per attempt.
  //
  // A current brain answers with its own factory/stamp-preflight.mjs, which is
  // the same code the stamp path gates on, so the status can never disagree with
  // the refusal. An older brain has no such file and cannot get one (a rock
  // cannot pull its brain after it is born), so the same five checks run inline
  // here against the environment ORG_GH_RESOLVE has already worked out. Same
  // JSON shape either way, so the app has one contract.
  'factory-status': {
    adminOnly: true,
    build: () => ({
      command: BR_RESOLVE + SOFT_FACTORY_ENV + ORG_GH_VERIFY + 'export AIOS_DIR=/app; '
        + 'if [ -f "$BR/factory/stamp-preflight.mjs" ]; then AIOS_BRAIN_ROOT="$BR" node "$BR/factory/stamp-preflight.mjs" --json; '
        + 'else node -e ' + `'${FACTORY_STATUS_FALLBACK}'` + '; fi',
    }),
  },

  'invite-member': {
    // BUILDS REAL INFRASTRUCTURE, so the bridge's 25s watchdog would kill it
    // part-way and strand what it had already created. Driven from the app on
    // 2026-08-05 this died at "waiting for the VM to boot" AFTER Hetzner had
    // made the server: a running, billing box with no registry row, invisible
    // to the app and with no teardown path. The watchdog is right about hung
    // verbs and wrong about long ones, so the long ones say how long.
    timeoutMs: 15 * 60 * 1000,
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const name = shq(a.name, 'name', 80);
      const email = String(a.email ?? '');
      if (!EMAIL_RE.test(email)) bad('that email doesn’t look like a normal address. Expected something like jane@example.com (only this address will be able to use the invite and sign in, so it must be exactly right)');
      const provider = String(a.provider || 'google');
      if (!['google', 'microsoft'].includes(provider)) bad('provider must be Google or Microsoft 365');
      let extra = '';
      // Membership levels are DEAD (killed brain-template 2026-07-27; app caught
      // up 2026-08-03, Sam's verb-interview ruling). a.tier from an older cached
      // UI is accepted and IGNORED, never refused: rejecting it stranded a live
      // stamp once (2026-07-24) and a dead field is not worth a second.
      if (a.region) { if (!WORD_RE.test(String(a.region))) bad('location (region) must be one lowercase word using only letters, numbers and hyphens. Leave it blank to use your rock’s default'); extra += ' --region ' + a.region; }
      // WHO OWNS THE PEBBLE. The form asks this and explains what it changes (a
      // member-owned brain is theirs and leaves with them; a rock-owned box is a
      // work asset whose brain lives in the rock's account), and THIS verb dropped
      // the answer on the floor, so every pebble created the normal way came out
      // member-owned whatever the admin chose. stamp-member (the advanced path,
      // where a device key is pasted in) carried it correctly all along and even
      // had a test, which is exactly why the gap survived: the covered path
      // worked and the default one did not. Blank still means the rock's default,
      // which is what the form's first option promises, so it passes nothing.
      if (a.owner !== undefined && a.owner !== '') {
        const own = String(a.owner);
        if (!['member', 'org'].includes(own)) bad('who owns the pebble must be the member, your rock, or left blank for your rock\u2019s default');
        extra += ' --owner ' + own;
      }
      return {
        command: 'set -e; ' + BR_RESOLVE + ONBOARD_GATE + FACTORY_ENV + ORG_GH_REQUIRED
          + ': "${PEBBLE_IMAGE:?your hub is not fully set up yet, so it cannot create member minerals. Ask whoever set up your hub (technical detail: PEBBLE_IMAGE, the member software image, is missing from /state/secrets/provisioning.env.local on the rock)}"; '
          + 'cd "$BR"; bash factory/stamp-pebble.sh --slug ' + slug + ' --name ' + name
          + ' --provider ' + provider + ' --email ' + email + ' --invite-pending' + extra + '; '
          + 'echo "^ Copy the invite link above and send it to ' + email + ' (only that address can complete it). It expires in 14 days."',
      };
    },
  },

  // D58 P1.5: the auto-approve activity feed. Verified devices enrol without an admin tap
  // (spec 2026-07-24 § 1), so the admin's role becomes informed-with-instant-revoke: this
  // read powers the panel's "Recent device activity" list; ending access runs
  // through the card's End flow (member-leave) since 2026-08-10.
  // D58 P4: request-to-join. The list read runs the rock's own reconcile (which
  // VERIFIES each request's ID token rock-side) then prints the verified queue;
  // approve rides the certified invite-pending stamp via factory/join-approve.sh.
  'join-requests': {
    adminOnly: true,
    build: () => ({
      command: BR_CD
        + '{ [ -f control/join-reconcile.mjs ] && node control/join-reconcile.mjs 2>&1 | grep -i dormant | sed "s/^/__DORMANT__ /"; } || true; '
        + 'cat control/join-requests.json 2>/dev/null || echo "[]"',
    }),
  },
  'join-approve': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id || '');
      if (!/^[0-9a-f]{8,40}$/.test(id)) bad('that request id does not look right; refresh the Requests list and try again');
      const slug = slugArg(a.slug);
      const name = shq(a.name, 'name', 80);
      const email = String(a.email ?? '');
      if (!EMAIL_RE.test(email)) bad('that email doesn’t look like a normal address');
      // levels dead (see stamp-member): a.tier ignored, never refused
      return {
        command: 'set -e; ' + BR_RESOLVE + ONBOARD_GATE + FACTORY_ENV + ORG_GH_REQUIRED
          + ': "${PEBBLE_IMAGE:?your hub is not fully set up yet, so it cannot create member minerals. Ask whoever set up your hub (technical detail: PEBBLE_IMAGE is missing from /state/secrets/provisioning.env.local)}"; '
          + 'cd "$BR"; bash factory/join-approve.sh --id ' + id + ' --slug ' + slug
          + ' --name ' + name + ' --email ' + email,
      };
    },
  },
  'join-decline': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id || '');
      if (!/^[0-9a-f]{8,40}$/.test(id)) bad('that request id does not look right; refresh the Requests list and try again');
      const note = a.note ? shq(String(a.note).slice(0, 300), 'note', 300) : "'Thanks for asking; not right now.'";
      return {
        command: 'set -e; ' + BR_CD + 'bash factory/join-approve.sh --id ' + id + ' --decline ' + note,
      };
    },
  },

  'device-activity': {
    adminOnly: true,
    build: () => ({
      command: BR_CD + 'cat control/device-activity.json 2>/dev/null || echo "[]"',
    }),
  },

  // Staged devices (D51 Phase 2): members who opened their invite link and whose PUBLIC key
  // was staged with the central broker. Runs the rock's own reconcile pull on demand
  // (fail-silent, ~6s worst case) then prints the staged list as JSON. An older brain
  // without the reconcile script returns [] and the manual paste-back path stands.
  'pending-devices': {
    adminOnly: true,
    build: () => ({
      // Lazy self-registration: the first poll from an admin panel registers the org with
      // the broker if it never has (mints the pull token on the box; fail-soft). So the
      // paste-free approve path lights up with zero setup steps for the admin.
      command: BR_CD
        + '{ [ -f control/broker-register.mjs ] && ! grep -q "^ORG_PULL_TOKEN=" .env 2>/dev/null && node control/broker-register.mjs >/dev/null 2>&1; } || true; '
        + '{ [ -f control/invite-reconcile.mjs ] && node control/invite-reconcile.mjs 2>&1 | grep -i dormant | sed "s/^/__DORMANT__ /"; } || true; '
        + 'cat control/pending-devices.json 2>/dev/null || echo "[]"',
    }),
  },

  // One-time broker registration (D51 Phase 2): the box mints its own pull token, keeps it
  // in the brain .env (never committed, never leaves the box), and claims the org handle at
  // the broker. Idempotent + fail-soft: with the broker unreachable the org just stays on
  // manual paste-back.
  'broker-register': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const host = String(a.host || '').trim();
      if (host && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) bad('host must be a plain hostname or IP');
      return {
        command: BR_CD
          + '[ -f control/broker-register.mjs ] || { echo "ERROR: this rock brain predates automatic invites (no control/broker-register.mjs). Update the brain from the template, or keep using the manual paste-back."; exit 1; }; '
          + 'node control/broker-register.mjs' + (host ? ' --host ' + host : ''),
      };
    },
  },

  // Fresh link for a member still waiting (status invited) whose link was lost or expired.
  // Rotates the token hash (the old link dies) and echoes the new self-describing link.
  'invite-reissue': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      return {
        // THE OWNERSHIP GATE (Sam's ruling 2026-08-10, second pebble grill):
        // since "the link is the proof", a rock minting a fresh device link for
        // a LIVE member-owned pebble is minting the enrolment proof for metal
        // it does not own — roster control on someone else's box, the same
        // class the pause ruling killed. Their account is the way in from any
        // new device (identity-model ruling 4). The one legitimate re-send is
        // the BIRTH link: a row still status "invited" has never enrolled, so
        // there is no account to be the way in yet, whatever ownership it was
        // stamped with. Absent owner defaults to member and fails CLOSED.
        command: BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'own=$(sed -n \'s/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); own=${own:-member}; '
          + 'st=$(sed -n \'s/^status: *"\\{0,1\\}\\([a-z]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); '
          + 'if [ "$own" = "member" ] && [ "$st" != "invited" ]; then echo "REFUSED: ' + slug + ' is member-owned and live, so the rock does not mint device links for their box: their account is the way in from any new device (they sign in and connect). A fresh invite can only be re-sent while they have never enrolled."; exit 1; fi; '
          + '[ -f factory/invite-reissue.sh ] || { echo "ERROR: this rock brain predates invite re-issue (no factory/invite-reissue.sh). Update the brain from the template, or remove and re-add the member."; exit 1; }; '
          + 'bash factory/invite-reissue.sh ' + slug,
      };
    },
  },

  // Members currently mid-invite (status invited): who is waiting on a device approval.
  'invite-pending-list': {
    build: () => ({
      command: BR_RESOLVE + 'for f in "$BR"/registry/members/*.yaml; do [ -f "$f" ] || continue; '
        + 'case "$f" in */_*) continue;; esac; '
        + 'grep -qE \'^status:[[:space:]]*"?invited"?\' "$f" && { echo "=== $f"; cat "$f"; }; done; '
        // An EMPTY list is the normal state, not a failure. The loop's last
        // statement is the grep, so with nobody waiting on an invite its
        // non-match became the verb's exit status and the panel reported
        // "__FAIL__ exit 1" (seen live 2026-08-03, once the only member had
        // claimed). Nothing pending is a fine answer: say so with exit 0.
        + 'exit 0',
    }),
  },

  // 'approve-device' was DELETED 2026-08-09 (Sam: "kill it, the link is the
  // proof"). It performed the acts control/auto-approve.mjs now performs by
  // itself on the box, behind a two-party fingerprint check the audit that day
  // showed was inert: the panel sent confirmed_fp and pubkey from the SAME
  // broker payload, so the re-derivation below compared broker data with broker
  // data and was equal by construction; the mismatch branch could only ever fire
  // on the hand-typed fallback, which is gone with it.
  //
  // Not replaced by an "approve anyway" override, deliberately. Everything that
  // still reaches the panel's pending list has been REFUSED by auto-approve, and
  // every refusal is either a data problem to fix elsewhere (no such member, not
  // active, no email) or a security refusal (invite-token binding mismatch, a
  // sign-in that failed its own check). An override would let an admin defeat the
  // invite-token binding, which is now the only thing proving a device is really
  // that member's. The panel shows the reason and says to send a fresh invite.

  // 'member-revoke' was DELETED 2026-08-10 (pebble-audit rulings 6+8): it was
  // one of TWO ceremonies for one outcome (member-leave detaches the same door
  // and additionally branches its copy on the registry owner), and the audit's
  // rule is that a verb never outlives its surface — the End flow runs
  // member-leave. It was also the only door-cutting verb with no confirmation
  // until earlier the same day.

  // ---- Skills (D49): the rock's skill library is the pushable catalog.
  // Authoring happens in Claude Code (/write-skill); the dashboard only lists
  // + distributes. skill-list is read-only (Support may view); skill-push is
  // Admin-only and runs the lint -> membership-gated push-down -> registry
  // upsert pipeline (orchestrator/push-skill.mjs).
  'skill-list': {
    build: () => ({
      command: BR_RESOLVE + 'for d in "$BR"/skills-library/*/; do [ -f "$d/skill.yaml" ] || continue; '
        + 'case "$d" in */_*) continue;; esac; echo "=== $(basename "$d")"; cat "$d/skill.yaml"; done',
    }),
  },

  'skill-push': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);                 // the MEMBER slug
      const skillId = String(a.skill_id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(skillId)) bad('skill_id must be kebab-case');
      return {
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + needsBrainScript('push-skill', 'the skill channel') + 'node orchestrator/push-skill.mjs ' + slug + ' ' + skillId,
      };
    },
  },

  // Vendor catalog (D57): pull the skill packages the vendor has granted THIS
  // deployment (staged config: deployment.yaml catalog_repo + the read-only
  // deploy key at /state/secrets/catalog_deploy_key) into the skills-library.
  // Unconfigured deployments report a clean no-op. Pull-only; the vendor never
  // reads anything out of this box.
  'catalog-sync': {
    adminOnly: true,
    mutating: true,
    build: () => ({ command: 'node /app/engine/ops/catalog-sync.mjs' }),
  },

  // Packs v2 (spec 2026-08-04 § 8): the library's bundles. Read-only listing
  // for the Skills tab; publishing rides the same catalog policy as skills.
  'pack-list': {
    build: () => ({
      command: BR_RESOLVE + 'for d in "$BR"/packs/*/; do [ -f "$d/pack.yaml" ] || continue; '
        + 'case "$d" in */_*) continue;; esac; echo "=== $(basename "$d")"; cat "$d/pack.yaml"; done',
    }),
  },

  // item-list (delivery-model step 7): the three item libraries that arrived
  // with prompts, pages and folders. skill-list and pack-list above each read
  // ONE root and predate them, and member.html parses both output shapes, so
  // this adds the missing roots alongside rather than changing either. Header
  // is "=== <kind>/<id>" (not the bare id the other two emit) because three
  // roots share one stream and an id is only unique within its own root.
  //
  // The marker checks mirror readKind() in brain-template's
  // control/catalog-reconcile.mjs exactly: an item whose payload is missing is
  // not catalogable THERE, so listing it HERE would offer the operator a
  // publish that reconcile then silently stages nothing for. The two must
  // agree, and this comment is the only thing holding them together.
  //
  // Skipping is by BASENAME, not by the '*/_*' path glob the two verbs above
  // use: that pattern matches an underscore anywhere in the resolved path, so
  // a brain root containing one would hide the whole library.
  'item-list': {
    build: () => ({
      command: BR_RESOLVE
        + 'for spec in "prompt prompts-library prompt.yaml PROMPT.md f" '
        + '"page pages-library page.yaml page.html f" '
        + '"dir dirs-library dir.yaml files d"; do '
        + 'set -- $spec; kind="$1"; root="$2"; man="$3"; marker="$4"; mtype="$5"; '
        + 'for d in "$BR/$root"/*/; do '
        + '[ -f "$d/$man" ] || continue; '
        + 'b="$(basename "$d")"; case "$b" in _*) continue;; esac; '
        + 'if [ "$mtype" = d ]; then [ -d "$d/$marker" ] || continue; '
        + 'else [ -f "$d/$marker" ] || continue; fi; '
        + 'echo "=== $kind/$b"; cat "$d/$man"; done; done',
    }),
  },

  // Member-facing catalog policy (spec 2026-08-04 § 7.1): which library items
  // each member can see + install from their app's Library page. Plain JSON on
  // the org brain (catalog/policy.json); publishing is the consent, entitlement
  // is per item per member, enforced at materialisation AND fulfilment.
  'catalog-policy': {
    build: () => ({ command: BR_RESOLVE + 'cat "$BR/catalog/policy.json" 2>/dev/null || echo "{}"' }),
  },
  // A rock opens (or closes) its own door on the public communities board.
  // The Worker route and the door's "Join a community" card both shipped on
  // 2026-08-04; nothing ever called the route, so the board could only ever be
  // empty and every stranger read "No communities have opened their door yet",
  // which funnels them to the dearest option the design meant to avoid.
  //
  // Authority is the rock's OWN pull token, read from its brain .env on
  // its own box: the same proof /requests and /unregister demand, and no
  // platform credential goes near customer metal. The handle comes from
  // org-policy.yaml rather than the caller, so an admin of one rock
  // cannot list another. Built as a command rather than a brain-template script
  // because box machinery is frozen at stamp time: this reaches rocks that
  // already exist.
  'community-listing': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const listed = a.listed === true;
      const blurb = String(a.blurb ?? '').trim();
      if (blurb) {
        if (blurb.length > 200) bad('the blurb is too long (200 characters is plenty)');
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(blurb)) bad('the blurb cannot contain control characters');
      }
      // THE BLURB NEVER TOUCHES THE SHELL. It rides in as base64 on stdin and is
      // decoded into the request body by node, exactly as catalog-policy-write
      // does. The first cut of this verb interpolated it into a single-quoted
      // shell word and refused " \ $ and backtick — but NOT the apostrophe, which
      // is the one character that ENDS a single-quoted string. So "We're a
      // builders' collective" silently corrupted the body, and a crafted blurb
      // executed arbitrary commands on the rock's rock container. My
      // own test called it "a hostile blurb is refused" while trying only a double
      // quote and $(whoami), so a green suite certified it as safe. Escaping is a
      // rule you have to keep getting right; not interpolating is a property.
      // THE ADVERTISEMENT (Sam, 2026-08-23): what the rock offers, and what it
      // charges to anchor and to join. Same rails as the blurb: bounded, no
      // control characters, base64 on stdin, never the shell.
      const extra = {};
      for (const [k, max, what] of [['offer', 300, 'what you offer'], ['anchor_terms', 140, 'the anchoring terms'], ['join_terms', 140, 'the joining terms']]) {
        const v = String(a[k] ?? '').trim();
        if (!v) continue;
        if (v.length > max) bad(`${what} is too long (${max} characters is plenty)`);
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(v)) bad(`${what} cannot contain control characters`);
        extra[k] = v;
      }
      const payload = JSON.stringify({ listed, ...(blurb ? { blurb } : {}), ...extra });
      return {
        command: BR_CD
          // SCOPED to the org: block, like every other handle read in this file.
          // The loose `first name: line anywhere` sed this used to run also
          // matches the Pulse section's own name:, so a policy with an empty
          // org.name could silently list under the wrong handle. Same trap
          // org-identity.mjs documents.
          + 'org=$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null); '
          + '[ -n "$org" ] || { echo "ERROR: org-policy.yaml has an empty org.name, so this rock has no handle to list under. '
          + 'That is the same gap that stops it registering with the directory and stamping members: fill org.name (and display_name) in the policy, then re-register."; exit 1; }; '
          // (The ORG_PULL_TOKEN registration gate and the T8 hosting gate left
          // with the board itself: there is no directory to be registered with.)
          // SELF-HOST STRIP (2026-09-01): the public sign-up board lived on the
          // central directory, which is deleted, so there is nothing to POST a
          // listing to. The stdin payload is drained (protocol unchanged) and
          // the verb answers honestly instead of curling a dead host.
          + 'base64 -d >/dev/null; '
          + 'echo "NOTE: the public sign-up board has been retired; community listings are moving to the commons model. Nothing was sent anywhere."',
        stdin: Buffer.from(payload, 'utf8').toString('base64') + '\n',
      };
    },
  },

  'catalog-policy-write': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 60000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~45 KB)');
      return {
        command: BR_CD + 'mkdir -p catalog; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'node -e "const o=JSON.parse(require(\'node:fs\').readFileSync(process.argv[1],\'utf8\')); if(typeof o!==\'object\'||Array.isArray(o))process.exit(1)" "$tmp" '
          + '|| { rm -f "$tmp"; echo "ERROR: policy is not a JSON object, nothing saved"; exit 1; }; '
          // R25 (panel iteration 2): every skill the posted policy offers to
          // somebody is scrubbed BEFORE the policy lands. One hit anywhere and
          // nothing is written; the hits print as file:line so the author can
          // fix the library copy and publish again. An image that predates the
          // scrubber says so rather than pretending it ran.
          + 'if [ -f /app/engine/ops/skill-scrub.mjs ]; then '
          + 'node /app/engine/ops/skill-scrub.mjs "$BR" --policy "$tmp" || { rm -f "$tmp"; echo "ERROR: nothing was published. Fix the lines above in the library copy and publish again."; exit 1; }; '
          + 'else echo "WARN: this rock\'s software is too old to scrub skills before publishing; nothing was checked."; fi; '
          + 'mv "$tmp" catalog/policy.json; echo "OK: catalog policy saved."',
        stdin: b64 + '\n',
      };
    },
  },

  // Pack authoring (Phase 5, task 2, 2026-08-25): editing prompts and pages
  // inside a pack that already exists. Deliberately narrow — creating a pack
  // means authoring a manifest with a category, a version and an entitlement
  // story, and a pack is still born in Claude Code, not through this form.
  //
  // pack-content-list: read side. Task 1's pack-content.mjs reports what
  // each pack ships versus what sits on disk, so the editor can show an
  // operator when they have written a prompt or page that ships nowhere.
  // Same dormant-fallback idiom as library-list / prompt-list: an old image
  // without the script reports an empty, honest state, never an error.
  'pack-content-list': {
    build: () => ({
      command: BR_RESOLVE + 'node /app/engine/appshell/pack-content.mjs "$BR" 2>/dev/null '
        + '|| echo \'PACKS_STATE {"packs":[],"dormant":"this box needs an update before it can show pack content"}\'',
    }),
  },

  // THE RULE (see the community-blurb verb above, catalog-policy-write below
  // it): content NEVER reaches the shell. It rides in as content_b64,
  // validated here against B64_RE with a size cap, and is delivered on
  // stdin, decoded in a temp location, checked, then moved into place. This
  // copies catalog-policy-write's shape exactly, on purpose.
  //
  // prompt-write: writes packs/<pack>/prompts/<name>.md. The verb adds the
  // .md itself, so `name` is not an arbitrary filename the operator
  // controls end to end — it still gets the strict kebab-case shape every
  // pack/page id in this file uses, refused by bad() before any command is
  // built. The pack must already exist (no directory is created for one
  // that does not), and an existing file is never overwritten blind.
  //
  // F3 (final review, 2026-08-26): mkdir, base64 -d and mv were chained with
  // bare `;`, so the command's own exit code was whatever `echo "OK: ..."`
  // returned: 0, always. A full disk, a read-only mount, or a prompts path
  // that is not a directory made mkdir (or base64, or mv) fail silently and
  // the operator still read "OK: ... saved" — member.html clears the
  // textarea on r.ok, so their only copy of what they typed was gone with
  // nothing on disk to show for it. Each step now checks its own exit
  // status explicitly (`|| { ...; exit 1; }`) rather than a bare `set -e`,
  // so nobody has to reason about whether the earlier `[ -e "$dest" ] && {
  // ...; exit 1; }` existence guard would itself trip errexit (it does not,
  // by POSIX's && / || exemption, but that is exactly the kind of shell
  // trivia this file should not depend on a reader knowing).
  'prompt-write': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      // target 'library' (delivery-model step 7) writes a STANDALONE prompt at
      // prompts-library/<name>/, the shape readKind() catalogues. Default stays
      // 'pack', byte-identical to before, because packs still work and every
      // existing caller passes no target at all.
      const target = String(a.target ?? 'pack');
      if (target !== 'pack' && target !== 'library') bad("target must be 'pack' or 'library'");
      const pack = String(a.pack ?? '');
      const name = String(a.name ?? '');
      const overwrite = a.overwrite === true;
      if (target === 'pack' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(pack)) bad('pack must be a kebab-case pack id');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) bad('name must be a kebab-case prompt name');
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 60000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~45 KB)');
      const lib = target === 'library';
      // Only built for the library path: manifestB64 refuses an unknown
      // category, and a pack write has no manifest and must not inherit that
      // refusal for an argument it never reads.
      const man = lib ? manifestB64(name, a) : '';
      const dir = lib ? `prompts-library/${name}` : `packs/${pack}/prompts`;
      const dest = lib ? `${dir}/PROMPT.md` : `${dir}/${name}.md`;
      return {
        command: BR_CD
          + (lib ? '' : `[ -f "packs/${pack}/pack.yaml" ] || { echo "ERROR: no pack named ${pack} on this mineral."; exit 1; }; `)
          + `dest="${dest}"; `
          + (overwrite ? '' : `[ -e "$dest" ] && { echo "ERROR: ${dest} already exists. Save with overwrite to replace it."; exit 1; }; `)
          + `mkdir -p "${dir}" || { echo "ERROR: could not create ${dir}. Nothing was saved."; exit 1; }; `
          + `tmp="$(mktemp)" || { echo "ERROR: could not create a temporary file. Nothing was saved."; exit 1; }; `
          + `base64 -d > "$tmp" || { rm -f "$tmp"; echo "ERROR: could not decode the content. Nothing was saved."; exit 1; }; `
          + `mv "$tmp" "$dest" || { rm -f "$tmp"; echo "ERROR: could not save the file. Nothing was saved."; exit 1; }; `
          // The manifest is written ONLY when absent, and only after the body
          // landed. Re-saving a prompt must never overwrite a title and
          // category the operator has since edited, and a manifest with no
          // body beside it is an item readKind() would skip anyway.
          + (lib
            ? `[ -f "${dir}/prompt.yaml" ] || echo '${man}' | base64 -d > "${dir}/prompt.yaml" `
              + `|| { echo "ERROR: the prompt body saved, but its details could not be written, so it will not appear in your catalogue."; exit 1; }; `
              + `echo "OK: prompt ${name} saved to your library."`
            : `echo "OK: prompt ${name} saved to ${pack}."`),
        stdin: b64 + '\n',
      };
    },
  },

  // page-write: writes packs/<pack>/pages/<id>.html, but only AFTER
  // page-lint.mjs passes on the decoded content — a page that fails the
  // lint cannot work in the sandboxed iframe it will run in (see
  // page-lint.mjs's own header), so this refuses it at save time rather
  // than shipping a page that silently does nothing. The decoded file is
  // renamed to <id>.html inside its own temp DIRECTORY before linting
  // (rather than left at its mktemp name) so the linter's own
  // `ERROR: <name>:<line>: <detail>` lines name the real page, not a temp
  // filename the operator has never seen. An image too old to carry the
  // linter saves with a warning, matching catalog-policy-write's skill-scrub
  // fallback.
  //
  // F3 (final review, 2026-08-26): same defect and same fix as prompt-write
  // above — mktemp -d, base64 -d, mkdir and mv were chained with bare `;`,
  // so a failure in any of them (full disk, read-only mount, a pages path
  // that is not a directory) still printed "OK: ... saved" with nothing
  // actually written, and member.html clears the operator's textarea on
  // r.ok. Each step now checks its own exit status explicitly.
  'page-write': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      // target 'library' (delivery-model step 7): a STANDALONE page at
      // pages-library/<id>/, which is what readKind() catalogues. The lint
      // below runs identically on both paths, so a standalone page is held to
      // exactly the same "will it work in the sandboxed iframe" bar as a
      // pack-nested one.
      const target = String(a.target ?? 'pack');
      if (target !== 'pack' && target !== 'library') bad("target must be 'pack' or 'library'");
      const pack = String(a.pack ?? '');
      const id = String(a.id ?? '');
      const overwrite = a.overwrite === true;
      if (target === 'pack' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(pack)) bad('pack must be a kebab-case pack id');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case page id');
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 100000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~75 KB)');
      const lib = target === 'library';
      const man = lib ? manifestB64(id, a) : '';
      const dir = lib ? `pages-library/${id}` : `packs/${pack}/pages`;
      const dest = lib ? `${dir}/page.html` : `${dir}/${id}.html`;
      return {
        command: BR_CD
          + (lib ? '' : `[ -f "packs/${pack}/pack.yaml" ] || { echo "ERROR: no pack named ${pack} on this mineral."; exit 1; }; `)
          + `dest="${dest}"; `
          + (overwrite ? '' : `[ -e "$dest" ] && { echo "ERROR: ${dest} already exists. Save with overwrite to replace it."; exit 1; }; `)
          + `tmpd="$(mktemp -d)" || { echo "ERROR: could not create a temporary directory. Nothing was saved."; exit 1; }; `
          + `tmp="$tmpd/${id}.html"; `
          + `base64 -d > "$tmp" || { rm -rf "$tmpd"; echo "ERROR: could not decode the content. Nothing was saved."; exit 1; }; `
          + 'if [ -f /app/engine/appshell/page-lint.mjs ]; then '
          + 'node /app/engine/appshell/page-lint.mjs "$tmp" || { rm -rf "$tmpd"; echo "ERROR: nothing was saved. The page will not work as written; fix the lines above and save again."; exit 1; }; '
          + 'else echo "WARN: this rock\'s software is too old to check the page before saving; nothing was checked."; fi; '
          + `mkdir -p "${dir}" || { rm -rf "$tmpd"; echo "ERROR: could not create ${dir}. Nothing was saved."; exit 1; }; `
          + `mv "$tmp" "$dest" || { rm -rf "$tmpd"; echo "ERROR: could not save the file. Nothing was saved."; exit 1; }; `
          + `rm -rf "$tmpd"; `
          // Manifest only when absent, and only after the body landed: same
          // rule as prompt-write, same reason.
          + (lib
            ? `[ -f "${dir}/page.yaml" ] || echo '${man}' | base64 -d > "${dir}/page.yaml" `
              + `|| { echo "ERROR: the page saved, but its details could not be written, so it will not appear in your catalogue."; exit 1; }; `
              + `echo "OK: page ${id} saved to your library."`
            : `echo "OK: page ${id} saved to ${pack}."`),
        stdin: b64 + '\n',
      };
    },
  },

  // R25: the scrub on its own, for a rock that wants to check a skill before
  // touching the policy. Same engine script, same words.
  'skill-scrub': {
    adminOnly: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case skill id');
      return {
        command: BR_RESOLVE + '[ -f /app/engine/ops/skill-scrub.mjs ] || { echo "ERROR: this rock\'s software is too old to scrub skills."; exit 1; }; '
          + `node /app/engine/ops/skill-scrub.mjs "$BR" ${id}`,
      };
    },
  },
  // Re-materialise every member's entitled catalog + fulfil pending install
  // requests now, instead of waiting for the next reconcile-all tick.
  'catalog-reconcile-run': {
    adminOnly: true,
    mutating: true,
    build: () => ({
      command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD
        // F3 (panel iteration 2): the request-queue reconcile is gone. One-inbox
        // made pickup local, nothing writes the queue, and brain-template
        // deleted the script; calling it only ever printed a node error.
        + 'node control/catalog-reconcile.mjs',
    }),
  },

  // Community catalogue push (2026-08-09 audit, R9): publish a set of this
  // rock's OWN skills to the directory, where every tied pebble (joined or
  // anchored) can browse them and members can install them. Replaces the
  // previously published catalogue wholesale. Category vocabulary is enforced
  // HERE first (audit R7) so the rock reads a named refusal on its own screen,
  // and again at the wire by the directory.
  // Read side of the community catalogue (Sam, 2026-08-10). The push verb
  // shipped 2026-08-09 with no reader, so nothing could ask what is CURRENTLY
  // listed. The old Publishing page papered over that by rendering an unticked
  // picker every time, which reads as "nothing is published" whether or not
  // that is true. The Catalogue page shows a per-skill Listed/Off state, so it
  // needs the real answer or it lies once per page load.
  // GET /community-catalog is public (the door markets it, CORS *), so this
  // carries no token; the handle still comes from org-policy.yaml on the box
  // rather than the caller, exactly as the push does, so an admin of one rock
  // cannot read another's under a forged argument. Not adminOnly: it discloses
  // nothing a stranger could not already fetch, and Support opens this page too.
  'community-catalog-list': {
    build: () => ({
      command: BR_CD
        + 'ORGN="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
        + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
        + 'if [ -z "$ORGN" ]; then echo \'COMMUNITY_CATALOG {"items":[],"dormant":"this rock has no handle in org-policy.yaml yet, so it cannot be listed"}\'; exit 0; fi; '
        + 'ANS="$(curl -s -m 8 "$DIR/community-catalog?org=$ORGN" 2>/dev/null || echo "{}")"; '
        + 'export ANS; node -e \'let c={};try{c=JSON.parse(process.env.ANS||"{}")}catch{};'
        + 'const ok=Array.isArray(c.items);'
        + 'console.log("COMMUNITY_CATALOG "+JSON.stringify({items:ok?c.items:[],updated:c.updated||0,'
        + '...(ok?{}:{dormant:"the directory did not answer just now"})}))\'',
    }),
  },

  'community-catalog-push': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
      // 0 is legal (Sam, 2026-08-10): the floor used to be 1, which made
      // "listed nowhere" unreachable — once a rock had published anything, the
      // catalogue could be replaced but never emptied. The worker has always
      // accepted an empty items array; only this guard stood in the way, and
      // the Catalogue page makes un-listing the last skill a one-click state.
      if (ids.length > 64) bad('ids must be 0..64 skill ids');
      for (const id of ids) if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad(`ids must be kebab-case: "${id}"`);
      return {
        command: 'set -e; ' + BR_CD
          + 'OTOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + '[ -n "$OTOK" ] || { echo "ERROR: this rock has no directory token (ORG_PULL_TOKEN) in its brain .env"; exit 1; }; '
          + 'ORGN="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
          + '[ -n "$ORGN" ] || { echo "ERROR: could not read this rock\'s handle from org-policy.yaml"; exit 1; }; '
          + 'DIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; DIR="${DIR:-https://directory.crads-ai.com}"; '
          + 'PAYLOAD="$(mktemp)"; '
          + 'node -e \''
          + 'const fs=require("fs");'
          + 'const CATS=["briefing","capture","comms","box","org","other"];'
          + 'const org=process.argv[1];const ids=process.argv.slice(2);const items=[];'
          // ONE STORE for both audiences (Sam, 2026-08-10). This read WAS
          // /state/.claude/skills/<id>/SKILL.md, the minerals own installed
          // skills, while the member audience (catalog-policy + skill-push) has
          // always read the distribution library. Two audiences on one page,
          // pulling from two different stores that nothing syncs, so the
          // Catalogue and the Skills page could never agree and neither was a
          // subset of the other. The library is the right store: the design
          // splits authoring (/write-skill writes skills-library/<id>/) from
          // distribution (the dashboard), and a library package already carries
          // the SKILL.md this needs.
          + 'for(const id of ids){'
          + 'const dir="skills-library/"+id;'
          + 'let md="";try{md=fs.readFileSync(dir+"/SKILL.md","utf8")}catch{console.error("ERROR: /"+id+" is not in this rock\\u2019s skills library ("+dir+"/SKILL.md). Author it with /write-skill in the Claude Code app, then publish it.");process.exit(1)}'
          + 'let y="";try{y=fs.readFileSync(dir+"/skill.yaml","utf8")}catch{}'
          + 'const fm=(md.match(/^---\\n([\\s\\S]*?)\\n---/)||[])[1]||"";'
          + 'const g=(s,k)=>((s.match(new RegExp("^"+k+":\\\\s*(.+)$","m"))||[])[1]||"").replace(/#.*$/,"").trim().replace(/^"|"$/g,"").trim();'
          // category lives in skill.yaml, NOT in SKILL.md frontmatter: the authoring
          // template puts name+description in the markdown and category+version+cadence
          // in the manifest. Reading only the frontmatter meant this verb refused
          // EVERY correctly-authored skill with `declares category ""`. Nothing caught
          // it because the page that drives it never rendered in the harness (the
          // skills-list fixture emitted the wrong prefix until 2026-08-10).
          // Frontmatter still wins where present, so a hand-written skill carrying it
          // inline keeps working.
          + 'const pick=(k)=>g(fm,k)||g(y,k);'
          + 'const category=pick("category");'
          + 'if(!CATS.includes(category)){console.error("ERROR: /"+id+" declares category \\""+category+"\\": the catalogue takes exactly "+CATS.join("|")+". Set it in "+dir+"/skill.yaml and publish again.");process.exit(1)}'
          + 'items.push({id,kind:"skill",version:parseInt(pick("version"),10)||1,category,title:pick("title")||pick("name"),description:pick("description"),content_b64:Buffer.from(md,"utf8").toString("base64")});'
          + '}'
          + 'process.stdout.write(JSON.stringify({org,items}))\' "$ORGN" '
          + ids.map((id) => `'${id}'`).join(' ')
          + ' > "$PAYLOAD" || { rm -f "$PAYLOAD"; exit 1; }; '
          + 'ANS="$(curl -s -m 20 -X POST -H "authorization: Bearer $OTOK" -H "content-type: application/json" --data @"$PAYLOAD" "$DIR/community-catalog")"; '
          + 'rm -f "$PAYLOAD"; '
          + 'echo "$ANS" | grep -q \'"ok"\' && echo "OK: '
          + (ids.length
            ? `the community catalogue for $ORGN now lists ${ids.length} skill(s)`
            : 'the community catalogue for $ORGN is now empty: tied rocks see nothing to browse')
          + '" '
          + '|| { echo "ERROR: the directory refused the publish: $ANS"; exit 1; }',
      };
    },
  },

  // Stall board (D48/D49): "who's stalling / about to churn" — the surface that
  // SELLS the product. Reads the registry index + each member's metadata
  // heartbeat (heartbeats/<slug>.json in the rock brain); the panel computes
  // risk. The rock still never reads a member box: heartbeats are metadata
  // the box emits and (via transport) ships up. Read-only; Support sees it too.
  'stall-board': {
    build: () => ({
      command: BR_RESOLVE + 'echo "__INDEX__"; cat "$BR/registry/index.json" 2>/dev/null || echo "[]"; '
        + 'echo "__HEARTBEATS__"; for f in "$BR"/heartbeats/*.json; do [ -f "$f" ] || continue; '
        + 'echo "=== $(basename "$f" .json)"; cat "$f"; done; '
        // The rock's OWN build stamp rides the same round trip (2026-08-23). Members
        // report app_commit in their heartbeat; without a reference it is a hex string
        // nobody can act on. The rock pulls the same promoted tag its members do, so
        // "same build as this rock" is the honest, self-contained comparison, and it
        // needs no directory call. A rock on a stale image says so about itself too.
        + 'echo "__SELFBUILD__"; cat /etc/aios-build 2>/dev/null || echo "{}"',
    }),
  },

  // ---- the public brain (S9, ruling R7 of the 2026-08-09 grilling) ---------
  // A rock shares a MARKED SUBSET of its own wiki with tied pebbles. All four
  // verbs ride engine/ops/brain-public.mjs on the box (one implementation for
  // the app AND the half-hourly cron); set/push re-filter personal/** +
  // enclave pages, and the directory's share flag makes OFF instant.
  'brain-public-list': {
    adminOnly: true,
    build: () => ({
      command: BR_RESOLVE + PUBBRAIN_GUARD + 'node /app/engine/ops/brain-public.mjs "$BR" list',
    }),
  },
  'brain-public-set': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const page = pageArg(a.page);
      const on = a.public === true;
      // the push rides along so a tick is live (or retracted) immediately
      return {
        command: BR_RESOLVE + PUBBRAIN_GUARD
          + `node /app/engine/ops/brain-public.mjs "$BR" set ${shq(page, 'page')} ${on ? 'on' : 'off'} `
          + '&& node /app/engine/ops/brain-public.mjs "$BR" push',
      };
    },
  },
  'brain-public-toggle': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => ({
      command: BR_RESOLVE + PUBBRAIN_GUARD
        + `node /app/engine/ops/brain-public.mjs "$BR" toggle ${a.on === true ? 'on' : 'off'}`
        + (a.on === true ? ' && node /app/engine/ops/brain-public.mjs "$BR" push' : ''),
    }),
  },

  // The rock's strength card asks one thing the data spine cannot carry: is
  // the org brain wired to a repo, and has a push actually left the box? The
  // same two reads member-console-state does for a pebble, against $BR. Any
  // token in the remote URL is stripped before it reaches the app.
  // Push the org brain to the repo it is already connected to. A VERB, not a
  // terminal hop: "Push it now" used to do activateSec('terminal') +
  // openTerm({autorun:'connect-github'}), which ran a sign-in script to do a
  // push, in a shell where STATE_DIR made it target /state ("/state is not a
  // git repository", Sam 2026-08-10). engine/brain-push.sh is the box's own
  // push lane: it resolves the brain correctly on its own, refuses to push
  // while credential-shaped material is unguarded, and writes the log
  // org-backup-status reads for "last push". GH_CONFIG_DIR is named because the
  // git credential helper shells out to gh, which needs to find the token
  // (trap 26, one surface over).
  'org-brain-push': {
    adminOnly: true,
    mutating: true,
    build: () => ({
      command: BR_RESOLVE
        + '[ -f /app/engine/brain-push.sh ] || { echo "ERROR: this mineral\'s software predates the brain-push lane. Restart it to pick up the latest published software."; exit 1; }; '
        // brain-push takes the STATE dir and derives <state>/brain, falling back
        // to <state> itself when that is absent. Hand it the rock of the
        // RESOLVED brain, so a relocated brain_root lands on the same directory
        // either way instead of the verb assuming /state/brain.
        + 'S="$(dirname "$BR")"; [ "$S/brain" = "$BR" ] || S="$BR"; '
        + 'export GH_CONFIG_DIR=/state/.kernel/gh; STATE_DIR="$S" bash /app/engine/brain-push.sh 2>&1; '
        + 'tail -3 "$S/cockpit/brain-push.log" 2>/dev/null || true',
    }),
  },

  // A REMOTE URL IS NOT A BACKUP (2026-08-12). This read used to report exactly
  // one thing — does .git/config name an origin — and the card turned that into
  // "Connected". So a remote that had been wired and never once pushed to (the
  // failed-adopt case) read as connected, and the only verb a connected card
  // offers is Push it now. Sam: "There is no option to Connect GitHub again."
  //
  // `pushed` is the honest question, and git already knows the answer: `git push
  // -u` writes a remote-tracking ref, so its existence is proof a push landed.
  // It also fixes a quieter lie in the other direction: `last` came only from
  // brain-push.log, which the 03:50 cron writes and connect-github does not, so
  // a rock that had JUST backed up successfully still read "nothing has been
  // pushed yet" until the following morning.
  'org-backup-status': {
    build: () => ({
      command: BR_RESOLVE + 'cd "$BR" 2>/dev/null || exit 0; '
        + 'U="$(git remote get-url origin 2>/dev/null || true)"; '
        + 'R="$(git rev-parse --verify -q "@{u}" 2>/dev/null || git rev-parse --verify -q origin/HEAD 2>/dev/null || true)"; '
        // ASK THE FAR END, NOT A LOCAL REF SOMETHING HAS TO REFRESH (findings
        // 196 + 197, 2026-08-17; the discipline finding 104's own near-miss
        // concluded with). 104's answer here was a credential-less `git fetch`
        // to move the tracking ref before reading its date. The backup repo is
        // PRIVATE BY DESIGN, so on a rock that fetch failed in 0.27s, every
        // single time, harmlessly and invisibly: the fix was inert on
        // precisely the boxes it was written for (196). And brain-push.log,
        // the other source of "last push", is written by a pebble cron absent
        // from ROCK_JOBS, so on a rock BOTH legs were dead and the timestamp
        // froze at whatever the ref was born with (197).
        //
        // gh already holds the token the connect flow installed (GH_CONFIG_DIR,
        // the same store connect-github's own push reads), so ask GitHub for
        // the repo's tip directly. One bounded read; every part of it is
        // allowed to fail, and an offline or unauthenticated box falls back to
        // exactly the local-ref behaviour that existed before.
        //
        // The far end's answer is better than fresher: it also closes the gap
        // the local ref cannot see. A tip this brain holds IS the proof a push
        // landed (the same `ours` test the backup leg runs before it adopts),
        // and a tip this brain has never seen means the remote is another
        // box's repo, which must read as NOT backed up however many tracking
        // refs a rejected push has left behind (trap 36: a remote URL is not a
        // backup).
        + 'export GH_CONFIG_DIR=/state/.kernel/gh; '
        + 'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; '
        // owner/name out of either URL shape. Single-quoted, which is
        // load-bearing: `"s#\\.git$##"` in double quotes expands `$#` to the
        // argument count and the expression dies (the backup leg's own trap).
        + 'SLUG="$(printf %s "$U" | sed -e \'s#^https://[^/]*/##\' -e \'s#^git@[^:]*:##\' -e \'s#\\.git$##\')"; '
        + 'FAR=""; '
        + 'if [ -n "$SLUG" ] && command -v gh >/dev/null 2>&1; then '
        + 'FAR="$(gh api "repos/$SLUG/commits?per_page=1" -q \'.[0].sha+" "+.[0].commit.committer.date\' 2>/dev/null || true)"; '
        + 'fi; '
        + 'TIP=""; FDATE=""; case "$FAR" in *" "*) TIP="${FAR%% *}"; FDATE="${FAR#* }";; esac; '
        + 'P=""; if [ -n "$TIP" ]; then '
        + 'if git cat-file -e "$TIP^{commit}" 2>/dev/null; then P=yes; else P=no; fi; '
        + 'fi; '
        + 'D="$(git log -1 --format=%cI "$R" 2>/dev/null || true)"; '
        + 'L="$(grep " pushed to " /state/cockpit/brain-push.log 2>/dev/null | tail -1 | cut -d" " -f1)"; '
        // Registration, from the same file the machinery reads: broker-register
        // writes ORG_PULL_TOKEN into the brain .env, and pebble-request refuses
        // without it. The capability ladder renders this line, so the card and
        // that refusal can never disagree.
        + 'G="$(grep -q "^ORG_PULL_TOKEN=." .env 2>/dev/null && echo yes || echo no)"; '
        + 'node -e \''
        + 'const [u,r,d,l,g,p,fd]=process.argv.slice(1);'
        + 'const connected=!!u;'
        + 'const repo=u?u.replace(/\\/\\/[^@\\/]*@/,"//").replace(/\\.git$/,""):"";'
        // p is the far end's verdict when it answered ("yes"/"no"), empty when
        // it could not be asked. Unreachable falls back to the tracking ref,
        // never to a claim the far end just contradicted.
        + 'const pushed=p?p==="yes":!!r;'
        // last: the far end's own commit date when the push is confirmed there,
        // else the log, else the (possibly frozen) ref date; worst case is the
        // pre-fix behaviour, never worse.
        + 'const last=(p==="yes"&&fd)||l||d||"";'
        + 'console.log("ORG_BACKUP "+JSON.stringify({connected,repo,pushed,last}));'
        + 'console.log("ORG_REG "+JSON.stringify({registered:g==="yes"}))\' '
        + '"$U" "$R" "$D" "$L" "$G" "$P" "$FDATE"',
    }),
  },

  // The rock map's four probes in ONE exec (2026-08-09 lag audit): same law as
  // the member 'topology-state' verb. adminOnly because rock-state is.
  'org-topology-state': {
    adminOnly: true,
    build: () => ({
      command: 'echo "__DEVICES__"; { ' + MEMBER_VERBS['devices-list'].build().command + '; } 2>/dev/null || true'
        + '; echo "__SUPPORT__"; { ' + MEMBER_VERBS['support-status'].build().command + '; } 2>/dev/null || true'
        + '; echo "__STALL__"; { ' + VERBS['stall-board'].build().command + '; } 2>/dev/null || true'
        + '; echo "__ROCKSTATE__"; { ' + VERBS['rock-state'].build().command + '; } 2>/dev/null || true',
    }),
  },

  // Governance: the org-policy.yaml editor (the panel renders it as a
  // structured form; this verb stays a raw read either way)
  'governance-read': {
    adminOnly: true,
    build: () => ({ command: BR_RESOLVE + 'cat "$BR/org-policy.yaml"' }),
  },

  // content arrives base64 over stdin (never on the command line); the renderer
  // validates BEFORE the real policy is replaced, so a refusal changes nothing.
  'governance-write': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 400000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~300 KB)');
      return {
        command: 'set -e; ' + BR_CD + 'tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'if ! node tools/render-identity.mjs --policy "$tmp" --tpl templates/CLAUDE.md.tpl --out-dir .; then '
          + 'rm -f "$tmp"; echo "POLICY REFUSED: org-policy.yaml NOT saved (fix the refusal above and save again)"; exit 1; fi; '
          + 'mv "$tmp" org-policy.yaml; git add org-policy.yaml CLAUDE.md notes/vocabulary.md; '
          + GIT_ID + ' commit -q -m "panel: governance edit (org-policy + re-render)" || echo "(no change to commit)"; '
          + GIT_PUSH + '; echo "OK: policy saved, identity re-rendered"',
        stdin: b64 + '\n',
      };
    },
  },

  // (The one-shot chat verb was removed 2026-07-23 with the Chat tab: the
  // Terminal tab plus the Claude Code app are the two ways to talk to the box.)

  // D55 update channel: restart this box's container to pick up published
  // software. IN-BAND restart: this command runs inside the very container it
  // restarts, so the kill is scheduled a beat ahead, detached from the session's
  // pipes (else ssh would hang on the open fds), and the verb returns cleanly
  // BEFORE it fires. PID 1 is tini, which forwards the TERM and exits; the host's
  // systemd (Restart=always) then re-runs ExecStartPre `docker pull` and brings
  // the box back on whatever its PINNED image tag now points at. Host-side files
  // (sshd config, enter-aios) are NOT touched here: those arrive via the signed
  // host-update bundles (docs/box-update-channel.md).
  'box-refresh': {
    adminOnly: true,
    mutating: true,
    build: () => ({
      command: 'echo "Restarting this rock\'s mineral to pick up the latest published software."; '
        + 'echo "Expect about a minute of outage: this panel, open terminals, Claude Code sessions and the browser IDE all drop, then reconnect on their own."; '
        + '(sleep 2; kill 1) </dev/null >/dev/null 2>&1 & '
        + 'echo "OK: restart scheduled. The mineral goes down in a few seconds; give it a minute, then refresh."',
    }),
  },

  // Danger: tear down ONE member box. Server-side re-check of the typed slug.
  // D60 O4: the OUTCOME COPY branches on the registry row's owner (the rock-side
  // mirror; the box is never read). Member-owned keeps the historical guarantee
  // verbatim; org-owned states the brain is the rock's repo, no member copy.
  // What kind of box the CONSOLE is running on, for the surfaces that must
  // differ between a natively-stamped rock and one promoted from a pebble.
  // Read-only. Promotion is detected the same way everywhere else in the
  // product: a native rock has no ownership.json at all, so its presence means
  // this box began life as a pebble and still has a personal seat to go back to.
  'box-kind': {
    build: () => ({
      command: BR_RESOLVE + 'node -e \'const fs=require("fs");'
        + 'let own=null;try{own=JSON.parse(fs.readFileSync("/state/ownership.json","utf8"))}catch{}'
        + 'let org="";try{const y=fs.readFileSync(process.argv[1]+"/org-policy.yaml","utf8");'
        + 'const m=y.match(/^\\s*name:\\s*"?([^"\\n#]+)"?/m);org=m?m[1].trim():""}catch{}'
        + 'process.stdout.write(JSON.stringify({tier:(own&&own.tier)||"",promoted:!!own,org}))\' "$BR"',
    }),
  },

  // DEMOTE: stop being a rock. adminOnly, and the script refuses while any
  // member remains (a paused member counts: they are one resume away from
  // expecting a rock to be there). It retires the directory handle
  // BEFORE flipping the tier, so a failure leaves an honest rock rather than a
  // box the directory still routes to.
  demote: {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const org = slugArg(a.org);
      if (a.confirm !== org) bad('to retire this rock, type its handle exactly as shown');
      // The override exists because /unregister may not be reachable; it BURNS
      // the handle, so it is opt-in and never the default.
      const leave = a.leave_handle_registered === true ? ' --leave-handle-registered' : '';
      return {
        // BR_RESOLVE, like every other org verb: the brain can be relocated by
        // deployment.yaml, and demote reads the registry and org-policy out of
        // it. Hardcoding /state/brain would demote the wrong brain on a
        // relocated box. (The repo's own guard caught this.)
        command: BR_RESOLVE
          + '[ -f /app/engine/promote/demote.mjs ] || { echo "ERROR: this mineral\'s software predates demotion. Update the mineral, then try again."; exit 1; }; '
          + 'AIOS_BRAIN_ROOT="$BR" node /app/engine/promote/demote.mjs' + leave,
      };
    },
  },

  'deprovision-member': {
    // BUILDS REAL INFRASTRUCTURE, so the bridge's 25s watchdog would kill it
    // part-way and strand what it had already created. Driven from the app on
    // 2026-08-05 this died at "waiting for the VM to boot" AFTER Hetzner had
    // made the server: a running, billing box with no registry row, invisible
    // to the app and with no teardown path. The watchdog is right about hung
    // verbs and wrong about long ones, so the long ones say how long.
    timeoutMs: 15 * 60 * 1000,
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to arm the teardown you must confirm by typing the member’s short username exactly as shown, nothing else');
      return {
        command: 'set -e; ' + FACTORY_ENV
          // the wizard's factory env stages the org GitHub owner as GH_OWNER, not
          // ORG_GH_OWNER (same naming gap SOFT_FACTORY_ENV bridges for the push
          // verbs); bridge it here so the org-owned echo can name the repo.
          + 'export ORG_GH_OWNER="${ORG_GH_OWNER:-${GH_OWNER:-}}"; '
          // THE OWNERSHIP GATE (Sam's ruling 2026-08-10: teardown never without
          // consent). The owner is read BEFORE anything is destroyed — the old
          // shape read it one statement after deprovision-pebble.sh, by which
          // point the VM, volume, tunnel and DNS were already gone, and used it
          // only to choose the closing sentence. Member-owned metal is
          // untouchable regardless of who pays for it; an absent owner defaults
          // to member (pre-O1 rows), which fails CLOSED here.
          + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'. Check the exact short username on the Fleet health tab."; exit 1; }; '
          + 'own=$(sed -n \'s/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); own=${own:-member}; '
          + 'if [ "$own" = "member" ]; then echo "REFUSED: ' + slug + ' is member-owned, and the rock never destroys member-owned metal. Evict ends the tie (your reason is delivered, their box re-anchors to Crads AI and its bill moves off this rock), or offer a transfer so the mineral becomes the rock\'s first. Teardown is for the rock\'s own work assets."; exit 1; fi; '
          + 'bash /app/provisioning/managed/deprovision-pebble.sh ' + slug + ' --yes; '
          + 'if [ -f "$f" ]; then sed -i \'s|^status:.*|status: "left"|\' "$f"; '
          + 'sed -i "s|^  left:.*|  left: \\"$(date +%F)\\"|" "$f"; '
          // A TORN-DOWN BOX IS NOT A DEPARTED MEMBER. member-revoke, member-leave
          // and this verb all wrote the same status "left" and nothing else, so the
          // row of a box whose VM, volume, tunnel and DNS were permanently deleted
          // was indistinguishable from someone who simply left. Fleet health then
          // offered "Bring back" on it, under copy asserting "their box and brain
          // were never destroyed, so nothing is rebuilt". Record the teardown so
          // the row can tell the truth about itself.
          + '[ -z "$(tail -c1 "$f")" ] || echo >> "$f"; grep -q "^decommissioned:" "$f" || printf \'decommissioned: ""\\n\' >> "$f"; '
          + 'sed -i "s|^decommissioned:.*|decommissioned: \\"$(date +%F)\\"|" "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' deprovisioned -> left" || true; ' + GIT_PUSH + '; '
          // D58 P5: prune the membership edge (status left). deprovision-client deletes
          // only the VM + DNS + tunnel; repo disposition is stated per owner below.
          + '{ [ -f control/edges-reflect.mjs ] && node control/edges-reflect.mjs >/dev/null 2>&1; } || true; fi; '
          // Only a non-member owner reaches this line (the gate above), so the
          // outcome copy no longer branches: a member-owned "their repo is
          // untouched" sentence here was the product reassuring someone about
          // their repo while announcing their box was destroyed.
          + 'echo "OK: ' + slug + ' torn down. This mineral\'s brain is the rock\'s repo (${ORG_GH_OWNER:-the rock}/' + slug + '-brain) and is retained by the rock; the member receives no copy (run a transfer first if you want to gift one)."',
      };
    },
  },

  // D58 P5 LEAVE, the soft case: the membership ends but the BOX is kept (a self-managed box on
  // the member's own cloud, or a member who is keeping their box). Detaches the door (empty key)
  // + flips status left + prunes the edge, and NEVER deprovisions the box.
  // For an org-managed box the admin wants the full teardown instead: use deprovision-member.
  // D60 O4: the outcome copy branches on the registry row's owner (rock-side mirror):
  // member-owned keeps "their mineral and repo are untouched"; org-owned states the box and
  // its brain remain the rock's.
  'member-leave': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to confirm the member is leaving, type their short username exactly as shown');
      // Reason ALWAYS (pebble-audit ruling, 2026-08-10: one ender, never a
      // silent cut, no exceptions). Same argv-not-sed transport the pause
      // writer proved out: operator text must never re-parse as shell.
      const reason = String(a.reason ?? '').trim();
      if (!reason) bad('a reason is required: it is recorded with the departure and carried to the person — never a silent cut');
      if (reason.length > 160) bad('the reason is too long (160 characters is plenty)');
      if (/[\x00-\x1f\x7f]/.test(reason)) bad('the reason cannot contain control characters');
      const rq = shq(reason, 'reason', 160);
      const stampReason = 'R=' + rq + '; '
        + 'node -e \'const fs=require("fs");const p=process.argv[1];const r=process.argv[2];'
        + 'const line="left_reason: "+JSON.stringify(r);let t=fs.readFileSync(p,"utf8");'
        + 't=/^left_reason:/m.test(t)?t.replace(/^left_reason:.*$/m,line)'
        + ':t+(t.endsWith("\\n")?"":"\\n")+line+"\\n";fs.writeFileSync(p,t)\' "$f" "$R"; ';
      return {
        // SOFT_FACTORY_ENV: the whole security effect of this verb is the key
        // DETACH below (push-member-key), which hard-exits 2 without ORG_GH_*.
        // Without it a departed member kept the org-installed SSH key while every
        // surface agreed they were gone. Same root cause as Pause, found together.
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'own=$(sed -n \'s/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); own=${own:-member}; '
          // Deliver the words BEFORE the row flips (push-down refuses
          // non-active rows). Fail-soft with honest words: an old brain
          // without leave-notice.mjs still completes the leave, and the
          // operator is told the reason was recorded but did not travel.
          + '{ [ -f orchestrator/leave-notice.mjs ] && node orchestrator/leave-notice.mjs ' + slug + ' --reason ' + rq + '; } '
          + '|| echo "WARN: the reason was recorded on the row but could NOT be delivered to their screen (this brain predates leave notices, or the channel was unreachable)."; '
          + stampReason
          + 'sed -i \'s|^status:.*|status: "left"|\' "$f"; '
          + 'sed -i "s|^  left:.*|  left: \\"$(date +%F)\\"|" "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' left (mineral kept)" || echo "(no change)"; ' + GIT_PUSH + '; '
          + needsBrainScript('push-member-key', 'door-key management') + 'node orchestrator/push-member-key.mjs ' + slug + ' || echo "WARN: the door key was NOT detached on the mineral (the org GitHub credentials were unreachable). They may still have access."; '
          + '{ [ -f control/edges-reflect.mjs ] && node control/edges-reflect.mjs >/dev/null 2>&1; } || true; '
          + 'if [ "$own" != "member" ]; then echo "OK: ' + slug + ' left. The mineral and its brain remain the rock\'s; their door key is detached."; '
          + 'else echo "OK: ' + slug + ' left. Their mineral and their brain repo are untouched; only your channel stopped."; fi',
      };
    },
  },

  // D60 O5a step 1 of 2: GRANT an org->member custody handoff for an ORG-OWNED box.
  // Stages transfer/to-member.json in the member's inbox (transfer-grant.mjs) and
  // stamps pending_transfer on the row. Deliberately does NOT flip owner: the member
  // must complete the take-ownership in their app (own-brain, grant-gated), and the
  // admin then runs transfer-complete, so the registry never claims a flip that has
  // not happened. The rock's repo is retained throughout (fresh-copy model).
  'transfer-to-member': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to grant the transfer, type the member’s short username exactly as shown');
      return {
        // BR_CD before set -e: the root probe exits non-zero where
        // deployment.yaml is absent (a brain that predates the 17 Aug stamp),
        // and under set -e that would kill the verb before its first word.
        command: BR_CD + 'set -e; f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'if grep -q \'^pending_transfer: "to-\' "$f"; then echo "REFUSED: a transfer is already pending for ' + slug + ' (see pending_transfer on the row). Complete it, or withdraw it with transfer-revoke."; exit 1; fi; '
          + 'own=$(sed -n \'s/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); own=${own:-member}; '
          + '[ "$own" != "member" ] || { echo "REFUSED: ' + slug + ' is member-owned; their brain already belongs to them, there is nothing to transfer."; exit 1; }; '
          + SOFT_FACTORY_ENV
          + needsBrainScript('transfer-grant', 'ownership transfer') + 'node orchestrator/transfer-grant.mjs ' + slug + ' grant; '
          // pre-O5a rows lack the pending_transfer line entirely and sed would no-op
          // (silent wedge, 2026-07-25 O5b gate): append it first, then stamp.
          + '[ -z "$(tail -c1 "$f")" ] || echo >> "$f"; grep -q "^pending_transfer:" "$f" || printf \'pending_transfer: ""\\n\' >> "$f"; '
          + 'sed -i "s|^pending_transfer:.*|pending_transfer: \\"to-member $(date +%F)\\"|" "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' transfer-to-member granted" || true; ' + GIT_PUSH + '; '
          + 'echo "OK: transfer granted. ' + slug + ' now completes it in their app (Own my brain: fresh copy under their own account). The rock keeps its copy (${ORG_GH_OWNER:-the rock}/' + slug + '-brain). Run transfer-complete once they confirm."',
      };
    },
  },

  // D60 O5a step 2 of 2: COMPLETE the handoff after the member took ownership in
  // their app. Requires the pending marker, flips the registry owner to member,
  // clears the marker, and mirrors the flip to the directory edge.
  'transfer-complete': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to complete the transfer, type the member’s short username exactly as shown');
      return {
        // SOFT_FACTORY_ENV, matching transfer-org-complete: the verifier below
        // reads the member's heartbeat repo and needs ORG_GH_OWNER/TOKEN. Adding
        // the verify step without the env made this verb ALWAYS fail with
        // "ORG_GH_OWNER + ORG_GH_TOKEN required (.env)", so transfer-to-member
        // could be granted and never completed. Found by running the handback on
        // a live pair; same omission as ask-push had.
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'grep -q \'^pending_transfer: "to-member\' "$f" || { echo "REFUSED: no pending transfer for ' + slug + '. Grant one first with transfer-to-member."; exit 1; }; '
          // 30d TTL (verb-interview ruling 2026-08-03): stale consent must not
          // complete months later; the staged date is on the marker itself.
          + 'PD="$(sed -n \'s/^pending_transfer: "to-member \\([0-9-]*\\)".*/\\1/p\' "$f" | head -1)"; '
          + 'if [ -n "$PD" ] && [ $(( ($(date +%s) - $(date -d "$PD" +%s 2>/dev/null || echo 0)) / 86400 )) -gt 30 ]; then '
          + 'echo "REFUSED: this offer lapsed (staged $PD, more than 30 days ago). Withdraw it with transfer-revoke and offer again."; exit 1; fi; '
          // Verified Complete (2026-08-03): the flip refuses until the member's
          // acceptance receipt is on the heartbeat channel. set -e makes the
          // verifier's exit 1 abort everything below; older brains without the
          // script keep the human-promise behaviour rather than bricking.
          + '{ [ -f orchestrator/transfer-member-verify.mjs ] && node orchestrator/transfer-member-verify.mjs ' + slug + '; } || { [ -f orchestrator/transfer-member-verify.mjs ] && exit 1 || true; }; '
          + '[ -z "$(tail -c1 "$f")" ] || echo >> "$f"; grep -q "^owner:" "$f" || printf \'owner: "member"\\n\' >> "$f"; '
          + 'sed -i \'s|^owner:.*|owner: "member"|\' "$f"; '
          + 'sed -i \'s|^pending_transfer:.*|pending_transfer: ""|\' "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' transfer-to-member complete (owner -> member)" || true; ' + GIT_PUSH + '; '
          + '{ [ -f control/edges-reflect.mjs ] && node control/edges-reflect.mjs >/dev/null 2>&1; } || true; '
          + 'echo "OK: ' + slug + ' now owns their brain (fresh copy under their account). The rock retains its original repo."',
      };
    },
  },

  // D60 O5b step 1 of 2: INVITE a member-owned box's custody to the rock.
  // Creates the org's <slug>-brain repo (empty init, main-existence gated, the O2
  // pattern) and stages the invitation + the two box scripts down the inbox
  // (transfer-invite.mjs). The member accepts in their app: their box mints its
  // own deploy key (the private half never travels) and publishes the public half
  // up the heartbeat channel, then flips its own ownership.json. Owner on the row
  // flips only at transfer-org-complete; pending_transfer marks the in-between.
  'transfer-to-org': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to invite the transfer, type the member’s short username exactly as shown');
      return {
        command: 'set -e; ' + FACTORY_ENV
          + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'if grep -q \'^pending_transfer: "to-\' "$f"; then echo "REFUSED: a transfer is already pending for ' + slug + ' (see pending_transfer on the row). Complete it, or withdraw it with transfer-revoke."; exit 1; fi; '
          + 'own=$(sed -n \'s/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); own=${own:-member}; '
          + '[ "$own" = "member" ] || { echo "REFUSED: ' + slug + ' is org-owned; the brain is already the rock\'s."; exit 1; }; '
          + 'export ORG_GH_OWNER="${ORG_GH_OWNER:-${GH_OWNER:-}}" ORG_GH_TOKEN="${ORG_GH_TOKEN:-${GITHUB_TOKEN:-}}"; '
          + 'export GH_TOKEN="${GH_TOKEN:-${ORG_GH_TOKEN:-}}"; '
          // the O2 repo-create fragment: create gated on view, init gated on branches/main
          + 'gh repo view "$ORG_GH_OWNER/' + slug + '-brain" >/dev/null 2>&1 || gh repo create "$ORG_GH_OWNER/' + slug + '-brain" --private -y >/dev/null; '
          + 'if ! gh api "repos/$ORG_GH_OWNER/' + slug + '-brain/branches/main" >/dev/null 2>&1; then TMP="$(mktemp -d)"; ( cd "$TMP"; git init -q -b main; git -c user.name=Rock-Brain -c user.email=factory@rock.local commit -q --allow-empty -m "init org-owned brain"; git push -q "https://x-access-token:$ORG_GH_TOKEN@github.com/$ORG_GH_OWNER/' + slug + '-brain.git" main ); rm -rf "$TMP"; fi; '
          + needsBrainScript('transfer-invite', 'ownership transfer') + 'node orchestrator/transfer-invite.mjs ' + slug + ' invite; '
          + '[ -z "$(tail -c1 "$f")" ] || echo >> "$f"; grep -q "^pending_transfer:" "$f" || printf \'pending_transfer: ""\\n\' >> "$f"; '
          + 'sed -i "s|^pending_transfer:.*|pending_transfer: \\"to-org $(date +%F)\\"|" "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' transfer-to-org invited" || true; ' + GIT_PUSH + '; '
          + 'echo "OK: invitation staged. ' + slug + ' now accepts in their app; their mineral mints its own key and only the public half travels. Run transfer-org-complete once they accept."',
      };
    },
  },

  // D60 O5b step 2 of 2: COMPLETE after the member accepted. Registers the
  // box-minted public key on the org repo (transfer-org-complete.mjs), then
  // flips the registry owner to org, clears the marker, and mirrors the edge.
  // The member keeps any personal repo they already owned (it freezes; fresh
  // custody starts at the org repo).
  'transfer-org-complete': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to complete the transfer, type the member’s short username exactly as shown');
      return {
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'grep -q \'^pending_transfer: "to-org\' "$f" || { echo "REFUSED: no pending transfer-to-org for ' + slug + '. Invite one first with transfer-to-org."; exit 1; }; '
          // 30d TTL (verb-interview ruling 2026-08-03): stale consent must not
          // complete months later; the staged date is on the marker itself.
          + 'PD="$(sed -n \'s/^pending_transfer: "to-org \\([0-9-]*\\)".*/\\1/p\' "$f" | head -1)"; '
          + 'if [ -n "$PD" ] && [ $(( ($(date +%s) - $(date -d "$PD" +%s 2>/dev/null || echo 0)) / 86400 )) -gt 30 ]; then '
          + 'echo "REFUSED: this invitation lapsed (staged $PD, more than 30 days ago). Withdraw it with transfer-revoke and invite again."; exit 1; fi; '
          // CONSENT (Harriet's audit 2026-08-19, point 3): the member's acceptance
          // used to be a file on the box that any box-shell holder (a support
          // session included) could produce. The record that only the member's
          // own sign-in can create lives at the directory; read it with the org
          // token and refuse to flip owner without it, or with one for a
          // different invitation. No consent, no custody, whatever the box says.
          + 'OTOK="$(grep -E "^ORG_PULL_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; '
          + 'ORGN="$(node -e \'const m=require("fs").readFileSync("org-policy.yaml","utf8").match(/^org:\\s*$[\\s\\S]*?^\\s+name:\\s*"?([^"\\n#]*)"?/m);process.stdout.write(m?m[1].trim():"")\' 2>/dev/null)"; '
          + 'CDIR="$(grep -E "^CRADS_DIRECTORY_URL=" .env 2>/dev/null | head -1 | cut -d= -f2-)"; CDIR="${CDIR:-https://directory.crads-ai.com}"; '
          + '[ -n "$OTOK" ] && [ -n "$ORGN" ] || { echo "REFUSED: this rock cannot read member consent (no ORG_PULL_TOKEN / org name); register the rock route first."; exit 1; }; '
          + 'CONSENT="$(curl -s -m 8 -H "authorization: Bearer $OTOK" "$CDIR/transfer-consent?org=$ORGN&slug=' + slug + '" 2>/dev/null || echo "{}")"; '
          + 'CINV="$(printf %s "$CONSENT" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s).consent;process.stdout.write(c&&c.invited?String(c.invited)+" "+String(c.receipt||""):"")}catch{}})\')"; '
          + '[ -n "$CINV" ] || { echo "REFUSED: ' + slug + ' has not consented to this transfer with their own sign-in (no consent on record at the directory). They accept in their app; a script run on the box is not consent."; exit 1; }; '
          + 'CDATE="${CINV%% *}"; CRCPT="${CINV##* }"; '
          + '[ "$CDATE" = "$PD" ] || { echo "REFUSED: the consent on record is for a different invitation (consented $CDATE, this one staged $PD). Ask ' + slug + ' to accept this invitation in their app."; exit 1; }; '
          + needsBrainScript('transfer-org-complete', 'ownership transfer') + 'node orchestrator/transfer-org-complete.mjs ' + slug + '; '
          + '[ -z "$(tail -c1 "$f")" ] || echo >> "$f"; grep -q "^owner:" "$f" || printf \'owner: "member"\\n\' >> "$f"; '
          // D60 invariant 6: an org-owned box may not be managed_by 'member'.
          // transferRowOwner enforces it and validateRow reports it, but this verb
          // never goes through either: it writes the owner line with a raw sed. A
          // self-run box (owner member + managed_by member, a legal stamped state)
          // could therefore be flipped to org ownership and land in a state the
          // model calls illegal, with every later read reporting a problem and no
          // verb that repairs it. Refuse before writing, and say which dial to
          // change first.
          + 'mb=$(sed -n \'s/^managed_by: *"\\{0,1\\}\\([a-z-]*\\)"\\{0,1\\}.*/\\1/p\' "$f" 2>/dev/null | head -1); '
          + '[ "$mb" != "member" ] || { echo "REFUSED: ' + slug + ' is managed by the member, and an org-owned mineral cannot be (D60 invariant 6). Change who runs the mineral first, then complete the transfer."; exit 1; }; '
          + 'sed -i \'s|^owner:.*|owner: "org"|\' "$f"; '
          + 'sed -i \'s|^pending_transfer:.*|pending_transfer: ""|\' "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' transfer-to-org complete (owner -> org)" || true; ' + GIT_PUSH + '; '
          + '{ [ -f control/edges-reflect.mjs ] && node control/edges-reflect.mjs >/dev/null 2>&1; } || true; '
          // one consent, one transfer: consume the record now that it served
          + 'curl -s -m 8 -X POST -H "authorization: Bearer $OTOK" -H "content-type: application/json" -d "{\\"org\\":\\"$ORGN\\",\\"slug\\":\\"' + slug + '\\",\\"receipt\\":\\"$CRCPT\\"}" "$CDIR/transfer-consent-consume" >/dev/null 2>&1 || true; '
          + 'echo "OK: custody is with the rock. Any personal repo ' + slug + ' already owned stays their own (frozen at transfer); the mineral pushes to the rock from the next kernel cycle."',
      };
    },
  },

  // D60 O5b gate fix: WITHDRAW a pending transfer (either direction) cleanly.
  // Clears the row marker AND removes the staged inbox artifacts, so the crossed
  // guard stops firing and the verbs become usable again. Post-accept note: if the
  // member already accepted a to-org (their box flipped), this only clears the
  // paperwork; the road back to member custody is transfer-to-member, which this
  // unblocks by clearing the marker.
  'transfer-revoke': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      if (a.confirm !== slug) bad('to withdraw the transfer, type the member’s short username exactly as shown');
      return {
        command: 'set -e; ' + SOFT_FACTORY_ENV + BR_CD + 'f=registry/members/' + slug + '.yaml; '
          + '[ -f "$f" ] || { echo "ERROR: there is no member called \'' + slug + '\'."; exit 1; }; '
          + 'dir=$(sed -n \'s/^pending_transfer: *"to-\\([a-z]*\\).*/\\1/p\' "$f" | head -1); '
          + '[ -n "$dir" ] || { echo "Nothing to withdraw: no transfer is pending for ' + slug + '."; exit 0; }; '
          + needsBrainScript('transfer-invite', 'ownership transfer')
          + needsBrainScript('transfer-grant', 'ownership transfer')
          + 'if [ "$dir" = "org" ]; then node orchestrator/transfer-invite.mjs ' + slug + ' revoke; '
          + 'else node orchestrator/transfer-grant.mjs ' + slug + ' revoke; fi; '
          + 'sed -i \'s|^pending_transfer:.*|pending_transfer: ""|\' "$f"; '
          + 'node registry/build-index.mjs; git add registry/; '
          + GIT_ID + ' commit -q -m "panel: ' + slug + ' transfer withdrawn (to-$dir)" || true; ' + GIT_PUSH + '; '
          + 'echo "OK: the pending to-$dir transfer for ' + slug + ' is withdrawn. If they had already ACCEPTED a to-org, the registry still says member: to give custody back, re-run transfer-to-org then transfer-org-complete, and only then transfer-to-member."',
      };
    },
  },

  // ---- the commons (commons-repo model, self-host pivot 2026-09-01) --------
  // A rock is a community hub with no metal: what it shares with members is a
  // git repo it owns (the commons), and these verbs are the owner's whole
  // surface: point at the repo (init), put the catalogue there (publish),
  // hand out and take back join bundles (grant/revoke, backed by the
  // rock-local roster in the org brain, never in the commons), and read state
  // (status/roster). Free-text fields ride STDIN as base64 and are validated
  // by commons-admin.mjs box-side; nothing typed can reach the shell (the
  // community-blurb lesson). Mutating verbs are adminOnly: a Support sign-in
  // must not repoint the commons or mint grants.
  'commons-status': {
    build: () => ({
      command: 'S=/app/engine/community/commons-admin.mjs; [ -f "$S" ] '
        + '&& { ' + BR_RESOLVE + 'node "$S" /state "$BR" status; } '
        + '|| echo \'COMMONS_STATE {"configured":false,"dormant":"this rock needs an update before it can run a commons"}\'',
    }),
  },
  'commons-roster': {
    build: () => ({
      command: 'S=/app/engine/community/commons-admin.mjs; [ -f "$S" ] '
        + '&& { ' + BR_RESOLVE + 'node "$S" /state "$BR" roster; } '
        + '|| echo \'ROSTER_STATE {"grants":[],"dormant":"this rock needs an update before it can run a commons"}\'',
    }),
  },
  'commons-init': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.payload_b64 ?? '');
      if (!b64 || b64.length > 40000 || !B64_RE.test(b64)) bad('payload_b64 must be base64 (the commons settings as JSON)');
      return {
        command: 'S=/app/engine/community/commons-admin.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this rock\'s software is too old to run a commons; update and restart it first."; exit 1; }; '
          + BR_RESOLVE + 'base64 -d | node "$S" /state "$BR" init',
        stdin: b64 + '\n',
      };
    },
  },
  'commons-publish': {
    adminOnly: true,
    mutating: true,
    build: () => ({
      command: 'S=/app/engine/community/commons-publish.mjs; [ -f "$S" ] '
        + '|| { echo "ERROR: this rock\'s software is too old to run a commons; update and restart it first."; exit 1; }; '
        + BR_RESOLVE + 'node "$S" /state "$BR"',
    }),
  },
  'commons-grant': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.payload_b64 ?? '');
      if (!b64 || b64.length > 8000 || !B64_RE.test(b64)) bad('payload_b64 must be base64 (the grant details as JSON)');
      return {
        command: 'S=/app/engine/community/commons-admin.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this rock\'s software is too old to run a commons; update and restart it first."; exit 1; }; '
          + BR_RESOLVE + 'base64 -d | node "$S" /state "$BR" grant',
        stdin: b64 + '\n',
      };
    },
  },
  'commons-revoke': {
    adminOnly: true,
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^g-[a-z0-9]{4,12}$/.test(id)) bad('id must be a grant id from the roster (it looks like g-xxxxxxxx)');
      return {
        command: 'S=/app/engine/community/commons-admin.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this rock\'s software is too old to run a commons; update and restart it first."; exit 1; }; '
          + BR_RESOLVE + `node "$S" /state "$BR" revoke ${id}`,
      };
    },
  },
};

// ---------------------------------------------------------------- member verbs
// The MEMBER edition's whole surface (D44): dashboard + brain viewer, nothing
// else. No chat (the member's EA lives in the Claude Code app), no org verbs,
// no admin verbs. The only write is the dashboard layout file: cockpit config,
// never brain content.
export const MEMBER_VERBS = {
  whoami: {
    build: () => ({ command: 'whoami' }),
  },

  // Dashboard: regenerate the box's own cockpit data (best-effort), then emit
  // data.json and layout.json between markers the client splits on. The card
  // set + derivation live in the engine ON THE BOX (git-pull updates every
  // member); the app is only a renderer.
  'dashboard-data': {
    build: (a = {}) => {
      // The rebuild must not be able to fail silently. It used to be `>/dev/null 2>&1
      // || true`, so when the builder threw (the onboarding layers/modules rename did
      // exactly that) the cat below still served the LAST GOOD data.json and the panel
      // rendered a frozen brain graph with no hint anything was wrong. Keep serving the
      // stale copy, because a stale dashboard beats a blank one, but carry the reason
      // out with it so the client can say so.
      // AIOS_CONNECTOR_PROBE: the box asking its own Claude account what the
      // member has connected in the app, which is the only way to tell "connected
      // for your chats" from "connected for your scheduled jobs". Opt-in, because
      // the probe starts every configured MCP server to health-check it.
      // The app ALWAYS ships ahead of the images, so the app is the side that has
      // to tolerate an older engine. It did not, and that is the whole of the
      // 2026-08-11 "0 of 8 forever" bug: dd96bd8 renamed client-cockpit.mjs to
      // box-cockpit.mjs with no shim, :v2 is still 2872ea5 which predates it, so
      // this line named a file no live box has. Every rebuild died
      // module-not-found, data.json was never written, and the dashboard fell
      // back to its empty state on every mineral, rock and pebble alike. It read
      // as a rock brain_root bug because the fallback strings look pebble-shaped.
      const GEN = 'GEN=/app/engine/cockpit/box-cockpit.mjs; [ -f "$GEN" ] || GEN=/app/engine/cockpit/client-cockpit.mjs; ';
      const rebuild = GEN + 'BUILD_ERR="$(AIOS_CONNECTOR_PROBE=1 node "$GEN" /state 2>&1 >/dev/null)" || true; ';
      // Cache gate (2026-08-09 lag audit): the rebuild walks the whole wiki, so a
      // data.json younger than 45s is served as-is. The polling client (60s) then
      // costs a cat, not a walk. fresh:1 forces the walk — fired after writes and
      // on a rising-edge connect, so an action is never answered by the cache.
      const gate = a.fresh
        ? rebuild
        : 'mt="$(stat -c %Y /state/cockpit/data.json 2>/dev/null || echo 0)"; '
          + 'if [ $(( $(date +%s) - mt )) -lt 45 ]; then BUILD_ERR=""; CACHE_HIT=1; else '
          + rebuild + 'fi; ';
      return {
        command: gate
          + 'echo "__BUILD__"; [ -n "$CACHE_HIT" ] && echo "__CACHED__"; [ -n "$BUILD_ERR" ] && printf "%s\\n" "$BUILD_ERR" | tail -6; '
          + 'echo "__DATA__"; cat /state/cockpit/data.json 2>/dev/null || echo "{}"; '
          + 'echo "__LAYOUT__"; cat /state/cockpit/layout.json 2>/dev/null || echo "{}"',
      };
    },
  },

  // Layout: the member's toggle + arrange choices, persisted ON THE BOX so any
  // shell they open sees the same dashboard. Validated as JSON box-side before
  // it replaces the previous layout; a parse failure changes nothing.
  'layout-write': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 20000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~15 KB)');
      return {
        command: 'set -e; mkdir -p /state/cockpit; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'node -e "JSON.parse(require(\'node:fs\').readFileSync(process.argv[1],\'utf8\'))" "$tmp" '
          + '|| { rm -f "$tmp"; echo "ERROR: layout is not valid JSON, nothing saved"; exit 1; }; '
          + 'mv "$tmp" /state/cockpit/layout.json; echo "OK: layout saved"',
        stdin: b64 + '\n',
      };
    },
  },

  // Cadence (D49): the member owns which pushed skills run and when. cadence-list
  // returns the installed skill manifests (the catalog) + the member's cadence.json
  // (their state); cadence-write persists their choices. The scheduler reads
  // cadence.json to decide what fires. Nothing runs unless the member enables it.
  // Three-layer v2 (2026-07-27): the same call also carries the run ledger
  // (skill-runs.json, id -> last-run ISO), the auto-update opt-out state, and
  // the last heartbeat time, so the app can show the MACHINERY jobs read-only
  // next to the member's own cadence — visible, never editable from here.
  // Cadence v2 (spec 2026-08-04): the same round trip now also carries the FULL
  // skill inventory (__ALLSKILLS__, engine-enumerated — any skill is schedulable,
  // not just org-pushed ones) and the scheduler's own resolved plan
  // (__PLANJSON__, machinery rows with this box's real jitter), so the page
  // renders what will actually fire, not a hand-maintained copy. The legacy
  // __SKILLS__ yaml blob stays for older app builds reading a newer box.
  'cadence-list': {
    build: () => ({
      // The skills dir follows the brain root: /state/.claude/skills on a
      // pebble, /state/brain/.claude/skills on a rock (boot-rock.sh installs
      // there). Live finding 2026-08-23: every verb here hardcoded /state and
      // the rock face showed its cadence ghosts as "yours" and nothing real.
      command: BR_RESOLVE + 'echo "__SKILLS__"; for d in "$BR"/.claude/skills/*/; do [ -f "$d/skill.yaml" ] || continue; '
        + 'case "$d" in */_*) continue;; esac; echo "=== $(basename "$d")"; cat "$d/skill.yaml"; done; '
        + 'echo "__CADENCE__"; cat /state/cockpit/cadence.json 2>/dev/null || echo "{}"; '
        + 'echo "__RUNS__"; cat /state/cockpit/skill-runs.json 2>/dev/null || echo "{}"; '
        + 'echo "__AUTOUPDATE__"; cat /state/cockpit/auto-update.json 2>/dev/null || echo "{}"; '
        + 'echo "__HEARTBEAT__"; node -e "try{console.log(JSON.stringify({generated_at:JSON.parse(require(\'node:fs\').readFileSync(\'/state/cockpit/heartbeat-full.json\',\'utf8\')).generated_at}))}catch{console.log(\'{}\')}"; '
        + 'echo "__ALLSKILLS__"; node /app/engine/appshell/skills-list.mjs /state 2>/dev/null '
        + '|| echo \'SKILLS_STATE {"skills":[],"cadence":{},"runs":{},"error":"engine-too-old"}\'; '
        // THE ROLE MUST TRAVEL WITH THE ASK (finding 86, re-opened 2026-08-13).
        //
        // scheduler.mjs decides its job list from AIOS_SCHEDULER_ROLE, and
        // boot-rock.sh:486 starts the real service with `AIOS_SCHEDULER_ROLE=rock`.
        // This verb did not, so on a ROCK `--plan-json` fell to the default
        // ('member') and answered with the member's 14 jobs. The Health card
        // renders exactly these rows under "Always-on machinery: part of the
        // software, shown so nothing runs invisibly", badged ON, above the word
        // "All good".
        //
        // Measured on qa-r2-gmail, born through the door this morning: the card
        // listed 14, and the box's own run-ledger held 4 job names over 26
        // entries (enrol-sync 15, grants 6, broker 3, reconcile 2). Ten rows that
        // have never run there, on the one card whose stated purpose is that
        // nothing runs invisibly.
        //
        // So finding 86 was fixed where it was diagnosed (machineryRows now
        // derives from the filtered job list) and re-entered through the READ
        // path. engine/cron/machinery-matches-jobs.test.mjs passes because it
        // sets the role itself; production never did. A check that supplies the
        // input production omits proves the wrong thing.
        //
        // The role is derived from the box's own ownership record rather than
        // from the panel's edition, so it stays true even if this verb is ever
        // reached from another surface.
        // Plain grep, deliberately. The first version of this line nested a
        // `node -e "..."` inside a `$( )` inside a double-quoted assignment, and
        // this file has already paid once for exactly that kind of quoting (the
        // `s#\.git$##` expansion in org-github-routes, where `$#` became the
        // argument count and every downstream check silently answered "no idea").
        // ownership.json is machine-written by boot-rock, so the field is stable,
        // and anything unreadable falls back to `member`, which is the safe
        // direction: it can only over-report, never hide a job that runs.
        + 'echo "__PLANJSON__"; __ROLE=member; '
        + 'grep -q \'"tier"[[:space:]]*:[[:space:]]*"rock"\' /state/ownership.json 2>/dev/null && __ROLE=rock; '
        + 'AIOS_SCHEDULER_ROLE=$__ROLE node /app/engine/cron/scheduler.mjs /state --plan-json 2>/dev/null || echo "{}"',
    }),
  },
  'cadence-write': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 40000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~30 KB)');
      return {
        command: 'set -e; mkdir -p /state/cockpit; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'node -e "const o=JSON.parse(require(\'node:fs\').readFileSync(process.argv[1],\'utf8\')); if(typeof o!==\'object\'||Array.isArray(o))process.exit(1)" "$tmp" '
          + '|| { rm -f "$tmp"; echo "ERROR: cadence must be a JSON object, nothing saved"; exit 1; }; '
          + 'mv "$tmp" /state/cockpit/cadence.json; echo "OK: cadence saved"',
        stdin: b64 + '\n',
      };
    },
  },

  // Skills system page (spec 2026-08-04): one JSON snapshot of every skill on
  // the box — engine, seed, org-pushed and member-authored — with category,
  // provenance, cadence + last-run joined in. The enumeration lives in the
  // engine ON THE BOX (skills-list.mjs), not in a quoting-tower here, so it is
  // unit-tested and git-pull-updatable. A box whose image predates the script
  // answers with an honest empty state instead of a shell error.
  'skills-list': {
    build: () => ({
      command: 'node /app/engine/appshell/skills-list.mjs /state 2>/dev/null '
        + '|| echo \'SKILLS_STATE {"skills":[],"cadence":{},"runs":{},"error":"engine-too-old"}\'',
    }),
  },
  // Run one skill NOW, through the same kernel door as cadence (enqueue +
  // drain, single-writer). Kebab-id validated app-side AND existence-checked
  // box-side; the last-run stamp lands in skill-runs.json first so the Skills
  // page reflects the run even if the reader looks before the drain finishes.
  'skill-run': {
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case skill id');
      return {
        command: BR_RESOLVE + `[ -f "$BR/.claude/skills/${id}/SKILL.md" ] || { echo "ERROR: no skill named ${id} is installed on this mineral."; exit 1; }; `
          + 'node -e \'const fs=require("fs");const f="/state/cockpit/skill-runs.json";'
          + 'let r={};try{r=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}'
          + `r["${id}"]=new Date().toISOString();`
          + 'fs.mkdirSync("/state/cockpit",{recursive:true});fs.writeFileSync(f,JSON.stringify(r,null,2)+"\\n")\'; '
          + `echo "Running /${id} now. This usually takes a minute or two."; `
          + `node /app/engine/kernel/enqueue.mjs /state ${id} --source=dashboard `
          + '&& node /app/engine/kernel/kernel.mjs /state --once',
      };
    },
  },

  // Library page (spec 2026-08-04 § 6.3/§ 7): the member's view of what their
  // rock has published for them. The catalog arrives via the org inbox (the
  // rock materialises each member's ENTITLED view, so this box holds only what
  // this member may see); installed state joins from the same enumerator the
  // Skills page uses. The __REQUESTS__ block (the "installing…" chip) went with
  // F3 of panel iteration 2: nothing has written the request queue since
  // one-inbox made pickup local.
  //
  // EVERY INBOX (2026-08-23). A box holds one inbox per rock it is tied to:
  // the anchor's at /state/org-inbox and one per joined rock at
  // /state/org-inbox.d/<owner>/ (tie-claim.mjs + org-sync.sh). The catalogue
  // is the union, every item tagged `rock` (the group label the Skills page
  // draws: what the catalogue names itself, else the rock's handle) and
  // `rock_id` (the handle from the conf's ORG= line, else the GitHub owner;
  // what catalog-install takes as `rock` to pick between two offers of one
  // id). The anchor's own `rock` field is kept at the top level, as before.
  'catalog-list': {
    build: () => ({
      command: 'echo "__CATALOG__"; node -e \'' + CATALOG_MERGE_JS + '\' 2>/dev/null || echo "{}"; '
        + 'echo "__ORGCONTACT__"; cat /state/org-contact.json 2>/dev/null || echo "{}"; '
        + 'echo "__ALLSKILLS__"; node /app/engine/appshell/skills-list.mjs /state 2>/dev/null '
        + '|| echo \'SKILLS_STATE {"skills":[],"cadence":{},"runs":{},"error":"engine-too-old"}\'',
    }),
  },
  // Install from the catalog: a local copy out of the staged inbox (one-inbox,
  // 2026-08-17). Publishing was the consent, so there is no approval step.
  // Community install (2026-08-09 audit, R9): a skill published by a rock the
  // member merely JOINED. The content arrived through the app (the member's
  // own sign-in is the tie proof; the directory gated it), so this verb only
  // writes it — with two refusals that protect what is already on the box:
  // never overwrite a skill that is not rock-published, and never let one rock
  // replace another rock's skill under the same id.
  // community-skill-apply is GONE (one-inbox, 2026-08-17). It wrote a SKILL.md
  // that the app had fetched from the directory straight onto the box: the
  // second delivery path, and the only writer that installed content the box
  // had not received through its own inbox. Its two refusals were the good part
  // and they live on in catalog-install below, which is now the one installer.
  'catalog-install': {
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case catalog id');
      // WHICH ROCK (2026-08-23): a box holds an inbox per tied rock, so an id
      // may be offered by more than one. `rock` is the handle (rock_id from
      // catalog-list) or the GitHub owner of the inbox to take it from. Without
      // it the anchor's offer wins; failing that a single joined rock's; two
      // joined rocks offering the same id is refused by name.
      const rock = a.rock === undefined || a.rock === '' ? '' : String(a.rock);
      if (rock && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(rock)) bad('rock must be a rock handle or GitHub owner');
      // Dirs (spec 2026-08-25 § 5.3) and pages (spec 2026-08-26-delivery-model
      // § 5b): kind picks the content path. 'skill' (the default) is the path
      // below, byte-identical to before kind existed. 'dir' and 'page' each
      // delegate to their own engine script, which owns the same anchor-first
      // / refuse-ambiguity resolution rules with its own tests.
      const kind = a.kind === undefined || a.kind === '' ? 'skill' : String(a.kind);
      if (kind !== 'skill' && kind !== 'dir' && kind !== 'page') bad('kind must be skill, dir or page');
      if (kind === 'dir') {
        return {
          command: BR_RESOLVE + '[ -f /app/engine/appshell/dir-install.mjs ] || { echo "ERROR: this box\'s software is too old to install directories. It updates itself overnight; try tomorrow, or press Update & restart."; exit 1; }; '
            + `node /app/engine/appshell/dir-install.mjs /state "$BR" ${id}${rock ? ' ' + rock : ''}`,
        };
      }
      if (kind === 'page') {
        return {
          command: BR_RESOLVE + '[ -f /app/engine/appshell/page-install.mjs ] || { echo "ERROR: this box\'s software is too old to install pages. It updates itself overnight; try tomorrow, or press Update & restart."; exit 1; }; '
            + `node /app/engine/appshell/page-install.mjs /state "$BR" ${id}${rock ? ' ' + rock : ''}`,
        };
      }
      const D = `$BR/.claude/skills/${id}`;
      // offers/ is where a one-inbox rock materialises entitled packages, and it
      // is deliberately NOT skills/: an old org-sync copies everything under
      // skills/ straight into .claude/skills, so putting the whole entitled set
      // there would auto-install the rock's catalogue on every box that had not
      // updated yet. skills/ stays as the fallback because a rock that has not
      // updated still pushes there on the old fulfilment path, so a member
      // updating ahead of their rock can still install what they already asked
      // for rather than losing it.
      // Legacy packs (pre-D49) shipped skills as loose <id>.md inside the pack.
      // Still staged, so still installable; found by search rather than by a
      // second code path.
      const SRC = `/state/org-inbox/offers/${id}`;
      const SRC_OLD = `/state/org-inbox/skills/${id}`;
      const LEGACY = `$(ls -1 /state/org-inbox/packs/*/skills/${id}.md 2>/dev/null | head -1)`;
      return {
        command: BR_RESOLVE + 'set -e; '
          + `ROCK="${rock}"; FOUND=0; OWNER=""; NAMES=""; `
          // pick <owner> <handle> <offer dir> <legacy file>: records the first
          // matching inbox and counts every one, so the two-rocks refusal can
          // name them. The anchor's candidates are spelled out in full below;
          // a joined inbox's follow the same three-step search under its dir.
          + 'pick(){ if [ -f "$3/SKILL.md" ] || [ -n "$4" ]; then '
          + 'if [ -n "$ROCK" ] && [ "$ROCK" != "$1" ] && [ "$ROCK" != "$2" ]; then return 0; fi; '
          + 'FOUND=$((FOUND+1)); NAMES="$NAMES ${2:-$1}"; '
          + '[ -n "$OWNER" ] || { OWNER="$1"; SRC="$3"; LEG="$4"; }; fi; }; '
          + 'AOWNER="$(grep -E "^ORG_GH_OWNER=" /state/org-inbox.conf 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\\"")"; '
          + 'AORG="$(grep -oP \'"org":\\s*"\\K[a-z0-9-]+\' /state/org-contact.json 2>/dev/null | head -1 || true)"; '
          + `SRC="${SRC}"; [ -f "$SRC/SKILL.md" ] || SRC="${SRC_OLD}"; LEG="${LEGACY}"; `
          + 'pick "${AOWNER:-your rock}" "$AORG" "$SRC" "$LEG"; ANCHOR_HAS=$FOUND; '
          + 'for d in /state/org-inbox.d/*/; do [ -d "$d" ] || continue; o="$(basename "$d")"; '
          + 'h="$(grep -oP "^ORG=\\K[a-z0-9-]+" "/state/org-inbox.d/$o.conf" 2>/dev/null | head -1 || true)"; '
          + 'js="${d%/}/offers/' + id + '"; [ -f "$js/SKILL.md" ] || js="${d%/}/skills/' + id + '"; '
          + 'jl="$(ls -1 "${d%/}"/packs/*/skills/' + id + '.md 2>/dev/null | head -1)"; pick "$o" "$h" "$js" "$jl"; done; '
          + `if [ "$FOUND" = 0 ]; then echo "ERROR: /${id} is not in your inbox. Your rock has not offered it to you, or it has not arrived yet (org-sync runs every 2 minutes)."; exit 1; fi; `
          + `if [ -z "$ROCK" ] && [ "$ANCHOR_HAS" = 0 ] && [ "$FOUND" -gt 1 ]; then echo "ERROR: /${id} is offered by more than one of your rocks ($(echo $NAMES | tr ' ' ',')). Say which one with rock."; exit 1; fi; `
          // The two refusals community-skill-apply carried, kept verbatim: they
          // are the reason a rock cannot overwrite something that is not its own.
          + `if [ -d "${D}" ] && [ ! -f "${D}/.origin.json" ]; then echo "ERROR: /${id} already exists on this mineral and is not a rock-published skill; nothing was changed."; exit 1; fi; `
          + `if [ -f "${D}/.origin.json" ] && ! grep -Eq "\\"rock\\":[[:space:]]*\\"$OWNER\\"" "${D}/.origin.json"; then echo "ERROR: /${id} is already installed from a different rock; nothing was changed."; exit 1; fi; `
          // R12: an update replaces local edits, so the old dir is kept first
          // under .claude/skill-backups/<id>.v<old> (old = the installed
          // version, 0 when unknown). NOT beside the skill: Claude Code walks
          // .claude/skills and would surface <id>.v2.bak/SKILL.md as a skill.
          // A backup of the same version is replaced, never stacked.
          + `if [ -d "${D}" ]; then OLD="$(grep -oP '"version":\\s*\\K[0-9]+' "${D}/.origin.json" 2>/dev/null | head -1 || true)"; `
          + `BK="$BR/.claude/skill-backups/${id}.v\${OLD:-0}"; mkdir -p "$BR/.claude/skill-backups"; `
          + `rm -rf "$BK"; cp -a "${D}" "$BK"; fi; `
          + `mkdir -p "${D}"; `
          + `if [ -f "$SRC/SKILL.md" ]; then cp "$SRC/SKILL.md" "${D}/SKILL.md"; `
          + `[ -f "$SRC/skill.yaml" ] && cp "$SRC/skill.yaml" "${D}/skill.yaml"; `
          + `[ -d "$SRC/context" ] && { mkdir -p "${D}/context"; cp -a "$SRC/context/." "${D}/context/" 2>/dev/null || true; }; `
          + `VER="$(grep -oP '^version:\\s*\\K[0-9]+' "$SRC/skill.yaml" 2>/dev/null | head -1 || true)"; `
          + `else cp "$LEG" "${D}/SKILL.md"; VER=""; fi; `
          // first-installed survives version bumps and re-installs, same rule the
          // old org-sync copy used
          + `INST="$(grep -oP '"installed":\\s*"\\K[^"]+' "${D}/.origin.json" 2>/dev/null | head -1 || true)"; `
          + '[ -n "$INST" ] || INST="$(date -u +%Y-%m-%d)"; '
          + `printf '{ "rock": "%s", "version": %s, "installed": "%s" }\\n' "$OWNER" "\${VER:-0}" "$INST" > "${D}/.origin.json"; `
          // R26: the origin header rides in SKILL.md's own frontmatter, so the
          // skill says where it came from even when read outside the app.
          // Existing keys are replaced in place, new ones prepended; a file
          // with no frontmatter gets a block. Re-installs never duplicate.
          + 'node -e \'' + ORIGIN_HEADER_JS + '\' ' + `"${D}/SKILL.md" "$OWNER" "\${VER:-0}" "$INST"; `
          + `echo "OK: /${id} installed. It shows up in Skills like everything else, and runs only when you switch it on."`,
      };
    },
  },

  // Uninstall a library directory (spec 2026-08-25 § 4). Member-owned act;
  // the tombstone it writes stops nothing explicit, only ever an automatic
  // re-materialisation, and a later install clears it.
  'dir-remove': {
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case directory id');
      return {
        command: BR_RESOLVE + '[ -f /app/engine/appshell/dir-remove.mjs ] || { echo "ERROR: this box\'s software is too old to remove directories. It updates itself overnight; try tomorrow, or press Update & restart."; exit 1; }; '
          + `node /app/engine/appshell/dir-remove.mjs "$BR" ${id}`,
      };
    },
  },

  // Ending a JOIN on the box side (2026-08-23). The directory edge is cut by
  // /rock-tie-leave; this removes what tie-claim.mjs put on the mineral for
  // that one rock: its inbox conf + contact card, its heartbeat conf, both
  // deploy keys, the keys-sent marker, and the two gitignored working clones.
  // Installed skills and seeded pages stay (never delete content). The anchor's
  // single files are never named here, so a leave of a joined rock can never
  // detach the anchor. Exit 0 with a NONE line when nothing is held: the leave
  // must be safe to re-run.
  'tie-drop': {
    mutating: true,
    build: (a = {}) => {
      const org = String(a.org ?? '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(org)) bad('name the rock to leave by its handle');
      return {
        command: 'set -e; OWNER=""; '
          + `for c in /state/org-inbox.d/*.conf; do [ -f "$c" ] || continue; if grep -qx "ORG=${org}" "$c"; then OWNER="$(basename "$c" .conf)"; break; fi; done; `
          + `[ -n "$OWNER" ] || { [ -f "/state/org-inbox.d/${org}.conf" ] && OWNER="${org}"; }; `
          + `[ -n "$OWNER" ] || { echo "TIE-DROP-NONE: no channel to ${org} on this mineral"; exit 0; }; `
          + 'rm -f "/state/org-inbox.d/$OWNER.conf" "/state/org-inbox.d/$OWNER.contact.json" "/state/heartbeat.d/$OWNER.conf"; '
          + 'rm -f "/state/secrets/org_inbox_deploy_key.$OWNER" "/state/secrets/org_inbox_deploy_key.$OWNER.pub" '
          + '"/state/secrets/heartbeat_deploy_key.$OWNER" "/state/secrets/heartbeat_deploy_key.$OWNER.pub" "/state/secrets/.tie-keys-sent.$OWNER"; '
          + 'rm -rf "/state/org-inbox.d/$OWNER" "/state/.heartbeat-out/$OWNER"; '
          + `echo "TIE-DROP-OK: left ${org} ($OWNER). Their inbox and status pipe are gone from this mineral; anything you installed from them stays."`,
      };
    },
  },

  // The other half of pickup, and the gap the 17 Aug audit found: a member could
  // install and never remove. R11 (panel iteration 2, 2026-08-23) widens it:
  // removable = anything that is NOT an engine skill. Engine ids are refused BY
  // NAME (the image's /app/engine/skills/<id>.md), because the kernel re-syncs
  // them every run and a removal would come straight back. Rock-published and
  // self-authored dirs both go; the wording tells the two apart, since a
  // rock-published skill is still on offer and a self-authored one is gone for
  // good (the UI's are-you-sure says "this is the only copy" for that case).
  //
  // The cadence entry goes WITH the skill now (R11: "removal deletes
  // /state/.claude/skills/<id> and its cadence entry"). Atomic rewrite: tmp +
  // rename, never a partial cadence.json under the scheduler.
  'skill-remove': {
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case skill id');
      const D = `$BR/.claude/skills/${id}`;
      return {
        command: BR_RESOLVE + 'set -e; '
          + `[ ! -f "/app/engine/skills/${id}.md" ] || { echo "ERROR: /${id} is a built-in skill and cannot be removed. Switch it off in Cadence instead."; exit 1; }; `
          + `[ -d "${D}" ] || { echo "ERROR: /${id} is not installed on this mineral."; exit 1; }; `
          + `ROCK=0; [ -f "${D}/.origin.json" ] && ROCK=1; `
          + `rm -rf "${D}"; `
          + 'node -e \'const fs=require("fs");const f="/state/cockpit/cadence.json";const id=process.argv[1];'
          + 'let c;try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{c=null}'
          + 'if(c&&typeof c==="object"&&!Array.isArray(c)&&Object.prototype.hasOwnProperty.call(c,id)){delete c[id];'
          + 'const t=f+".tmp."+process.pid;fs.writeFileSync(t,JSON.stringify(c,null,2)+"\\n");fs.renameSync(t,f)}\' '
          + `"${id}" 2>/dev/null || true; `
          + `if [ "$ROCK" = 1 ]; then echo "OK: /${id} removed. Your rock still offers it, so you can add it again any time."; `
          + `else echo "OK: /${id} removed. That was the only copy."; fi`,
      };
    },
  },

  // R11 "Read the skill": the app renders SKILL.md in a drawer. Filename-gated
  // id; works for engine skills too, since they live under the same dir once
  // synced. base64 so the content never meets the line parser. Contract:
  //   __SKILL__ <b64 of SKILL.md>
  //   __META__ <b64 of skill.yaml>        (only if present)
  //   __ORIGIN__ <b64 of .origin.json>    (only if present)
  'skill-read': {
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case skill id');
      const D = `$BR/.claude/skills/${id}`;
      return {
        command: BR_RESOLVE + `[ -f "${D}/SKILL.md" ] || { echo "ERROR: /${id} is not installed on this mineral."; exit 1; }; `
          + `echo "__SKILL__ $(base64 -w0 "${D}/SKILL.md")"; `
          + `[ -f "${D}/skill.yaml" ] && echo "__META__ $(base64 -w0 "${D}/skill.yaml")"; `
          + `[ -f "${D}/.origin.json" ] && echo "__ORIGIN__ $(base64 -w0 "${D}/.origin.json")"; true`,
      };
    },
  },

  // Sharing (D49): the member controls WHAT the automatic heartbeat carries up.
  // sharing-list returns their toggles + the local full snapshot (for an honest
  // "what would this reveal" preview) + what is actually shared. sharing-write
  // persists the toggles; the hourly heartbeat then filters to them. Box health
  // (liveness + sign-in) is the always-on floor and is not in the toggles.
  'sharing-list': {
    build: () => ({
      command: 'echo "__SHARING__"; cat /state/cockpit/sharing.json 2>/dev/null || echo "{}"; '
        + 'echo "__FULL__"; cat /state/cockpit/heartbeat-full.json 2>/dev/null || echo "{}"; '
        + 'echo "__SHARED__"; cat /state/cockpit/heartbeat.json 2>/dev/null || echo "{}"',
    }),
  },
  'sharing-write': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 10000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~7 KB)');
      // MERGE, never replace (R10, 2026-08-23). This used to `mv` the posted
      // object over sharing.json, and the page only ever posts the toggles it
      // renders. sharing.json also carries `public_brain`, written by
      // engine/ops/brain-public.mjs and read by the scheduler's half-hourly
      // public-brain push, so every save from the Sharing page silently turned
      // the public brain off. Posted keys win; everything else in the file
      // survives. Still atomic: the merged result lands via tmp + mv.
      return {
        command: 'set -e; mkdir -p /state/cockpit; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'node -e "const fs=require(\'node:fs\');const o=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\')); if(typeof o!==\'object\'||o===null||Array.isArray(o))process.exit(1);'
          + 'let cur={};try{cur=JSON.parse(fs.readFileSync(process.argv[2],\'utf8\'))}catch{cur={}};if(typeof cur!==\'object\'||cur===null||Array.isArray(cur))cur={};'
          + 'fs.writeFileSync(process.argv[1],JSON.stringify(Object.assign(cur,o),null,2)+String.fromCharCode(10))" "$tmp" /state/cockpit/sharing.json '
          + '|| { rm -f "$tmp"; echo "ERROR: sharing must be a JSON object, nothing saved"; exit 1; }; '
          + 'mv "$tmp" /state/cockpit/sharing.json; echo "OK: sharing saved (takes effect on the next heartbeat)"',
        stdin: b64 + '\n',
      };
    },
  },

  // D60 O5b: accept a pending transfer-to-org invitation. Member-run by design:
  // executing this on their own box IS the consent (the box mints its own key,
  // publishes only the public half, and flips its own ownership.json last).
  // A clean no-op message when nothing is staged.
  // E6.1 member seat: the box's own dials + what waits on the member's consent.
  // ONE-HOP SIGHT by construction: everything here is read from /state on the
  // member's OWN box (ownership.json, org-contact.json, the org inbox); a
  // member seat never reads a registry or anyone else's plane.
  'member-console-state': {
    // Runs behind BR_RESOLVE (exported as $BR) like the org verbs do: this
    // verb carried the member-born fallback before anything else did, but as
    // its own two hand-rolled copies — one of which never learned the
    // deployment.yaml leg. One resolver now, shared with everything.
    build: () => ({
      command: BR_RESOLVE + 'node -e \''
        + 'const fs=require("fs");'
        + 'const j=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};'
        + 'const own=j("/state/ownership.json")||{};'
        + 'const org=j("/state/org-contact.json")||{};'
        + 'const inv=j("/state/org-inbox/transfer/to-org.json");'
        + 'const asks=[];for(const k of ["ask-read","ask-install","reframe"]){'
        + 'const a=j("/state/org-inbox/asks/"+k+".json");if(!a)continue;'
        + 'const done=j("/state/asks/"+k+"-answer.json");'
        + 'if(done&&done.asked===a.asked)continue;'
        + 'asks.push({kind:k,from:a.from||"",asked:a.asked||"",note:a.note||"",framework:a.framework||"",intensity:a.intensity||""})}'
        + 'const grant=j("/state/org-inbox/transfer/to-member.json");'
        // Is this box anchored to a rock? The Mountain model makes
        // ownership.json.anchor authoritative ("crads-ai" is the Mountain, i.e.
        // no rock above you), so ask THAT rather than inferring it from
        // a config file's existence. Eviction flips the anchor and does not
        // remove heartbeat.conf, so the old test left an evicted member's seat
        // still naming the rock that had just evicted them, still offering
        // "Leave this rock" for a membership that had ended, and still
        // hiding the promote panel (gated on !anchored) from a box that was by
        // then Mountain-anchored and free to promote. Fall back to the file for
        // a box whose ownership record predates the anchor field.
        + 'const anchored=own.anchor?own.anchor!=="crads-ai":fs.existsSync("/state/heartbeat.conf");'
        // Backup state (2026-07-30): is this brain connected to the owner's own repo,
        // and when did it last actually leave the box? The console needs both, because
        // "connected" without a recent push is not a backup. The remote URL is read
        // from git config directly rather than shelling git, so a repo mid-operation
        // cannot make the whole probe fail. Any token in the URL is stripped: this
        // string goes to the app, and a credential must never ride along.
        + 'let backup={connected:false,repo:"",last:""};'
        + 'try{const brr=process.env.BR||"/state";'
        + 'const cfg=fs.readFileSync(brr+"/.git/config","utf8");'
        + 'const u=(cfg.match(/\\[remote "origin"\\][\\s\\S]*?url\\s*=\\s*(\\S+)/)||[])[1]||"";'
        + 'if(u){backup.connected=true;backup.repo=u.replace(/\\/\\/[^@\\/]*@/,"//").replace(/\\.git$/,"")}'
        + '}catch{}'
        // WHOSE repo it is. `connected` was set for ANY origin with no owner
        // check, and on an org-owned box org-brain-wire.sh points origin at the
        // ROCK's repo, so the member's own app told them their brain was
        // "private, in your own GitHub account, every night" while every commit
        // went to the rock. That is the one sentence on that card a
        // member would actually rely on.
        + 'backup.org_owned=!!(own.owner&&own.owner!=="member");'
        + 'backup.owner_label=backup.org_owned?(own.owner_slug||own.owner||"your rock"):"";'
        + 'try{const lg=fs.readFileSync("/state/cockpit/brain-push.log","utf8").trim().split("\\n");'
        + 'for(let i=lg.length-1;i>=0;i--){if(/ pushed to /.test(lg[i])){backup.last=lg[i].split(" ")[0];break}}}catch{}'
        + 'let nm="";try{nm=fs.readFileSync("/state/box-name","utf8").trim().slice(0,60)}catch{}'
        // one-name ruling (2026-08-09): a box never renamed still has a name,
        // the assistant's own, so the seat and the map never say "Your mineral"
        // for a box that introduced itself in onboarding
        + 'if(!nm){try{nm=((fs.readFileSync("/state/profile.yaml","utf8").match(/assistant_name:\\s*"?([^"\\n]+)"?/)||[])[1]||"").trim().slice(0,60)}catch{}}'
        + 'const lineage=j((process.env.BR||"/state")+"/lineage.json")||j("/state/lineage.json");'
        // R9: the ties the app wrote down (ties-write); the map draws them all
        + 'const ties=(j("/state/ties.json")||{}).ties||[];'
        // A promotion still in flight (2026-08-17). The seat resumes its watch
        // from this, which is what makes "you can close this and come back"
        // true. Written by /promote/start, deleted by the flip itself.
        + 'const promo=j("/state/promotion-pending.json")||null;'
        // Custody log (Harriet audit point 4, 2026-08-19): every ownership /
        // anchor / support / grant change custody-watch.mjs saw, newest first,
        // so the member reads their own history here instead of a git log.
        + 'let custody=[];try{custody=fs.readFileSync("/state/custody-log.jsonl","utf8").trim().split("\\n").filter(Boolean).slice(-40).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean).reverse()}catch{}'
        + 'console.log("CONSOLE_STATE "+JSON.stringify({'
        + 'ownership:{owner:own.owner||"member",owner_slug:own.owner_slug||"",managed_by:own.managed_by||"org",tier:own.tier||"pebble",machinery_by:own.machinery_by||"crads-ai"},'
        // THE ROCK'S NAME, not just its handle (2026-08-14, docs/naming.md).
        // This block shipped `name` alone, so the pebble face had nothing but
        // the slug to render: an admin read "Acme CoLab" on their own
        // Ownership and Anchor rows while every one of their members read
        // "impact-colab" on theirs. org-contact.json is a free-form card the
        // rock stages in its wire bundle, so a rock that puts its name in there
        // is now honoured; the directory edge (org_display) remains the panel's
        // better source, and the handle is the last resort.
        + 'org:{name:org.org||org.name||"",display:org.org_display||org.display||"",admin_email:org.admin_email||""},'
        // THE ANCHOR'S SLUG, not just the bool (finding 114/115, 2026-08-13).
        // ownership.json.anchor is the only local truth about which rock holds
        // this mineral, and dropping it here left the Rocks page with nothing
        // but /rock-mine, whose edges are keyed to the signed-in account at the
        // directory. When that read came back empty the page told an anchored,
        // org-managed pebble "You have not tied to any rocks yet. You own your
        // pebble; it is hosted and billed directly" — false on both halves, and
        // contradicted by Your pebble, by the Map, and by its own card two
        // inches below ("they pay for your pebble instead of you"). It then
        // listed that same rock under "Rocks you have not tied to" and offered
        // Join and Ask to anchor on it. One field closes all of it.
        + 'anchored,anchor:(own.anchor&&own.anchor!=="crads-ai"?own.anchor:""),name:nm,backup,ties,custody,'
        + 'promotion:(promo&&promo.id?{id:String(promo.id),org_handle:String(promo.org_handle||""),at:promo.at||0}:null),'
        + 'waiting:{transfer_invitation:inv?{invited:inv.invited||"",org_slug:inv.org_slug||""}:null,ownership_grant:grant&&grant.granted?{granted:grant.granted}:null,asks},'
        + 'lineage,'
        + 'generated:new Date().toISOString()}))\'',
    }),
  },

  // R9 (2026-08-09 grilling): ties land ON THE BOX. The directory is the only
  // place that knows a tie made after stamp time, but the map's law is "live
  // from your box" — so the app writes the ties it learns down to
  // /state/ties.json, and the map keeps working offline and sign-in-free.
  // Validated box-side as strictly as layout-write; capped at 20 rows.
  // ---- enrolment arming, mineral side (T9b, 2026-08-10) ---------------------
  // Writes the two facts enrol-sync guards on: owner_e (whose account may
  // enrol devices here) and box_directory_token (minted ON the mineral, never
  // passed in — the mineral's secret binds its directory name). Box-side
  // guards make it safe for the app to try every configured mineral: an
  // org-owned mineral refuses (its enrolment rides the rock path), an already-
  // armed mineral refuses a DIFFERENT owner in words, and a profile email that
  // contradicts the claimed owner refuses rather than letting a mis-configured
  // target be quietly claimed. Field minerals act on it once the image with
  // the enrol-sync scheduler leg reaches them.
  // ---- ownership + access, mineral side (2026-08-10) ------------------------
  // Replaces enrol-arm, which could never fire: it derived the owner by
  // grepping /state/profile.yaml for an `email:` field the schema does not
  // have (on a real mineral that regex returns "enabled: false"), so arming
  // always refused and no mineral ever registered. The owner is now stated by
  // the signed-in account rather than guessed from a file.
  //
  // mineral-claim writes the holder + the owner grant + the serial, all
  // through engine/lib/mineral-identity.mjs so the rules (first claim wins,
  // never re-serial, holder always has access) live in ONE tested place
  // rather than in a shell string. Sent as JSON on stdin, never argv.
  'mineral-claim': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 8000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~6 KB)');
      return {
        command: 'set -e; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + '[ -f /app/engine/lib/mineral-identity.mjs ] || { rm -f "$tmp"; '
          + 'echo "ERROR: this mineral\'s software predates the ownership model. It updates itself overnight; try tomorrow, or press Update & restart."; exit 1; }; '
          + 'node --input-type=module -e \'const {claimOwner,identityFacts}=await import("/app/engine/lib/mineral-identity.mjs");'
          + 'const fs=await import("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'
          + 'const r=claimOwner("/state",{kind:"account",account_id:c.account_id,email:c.email});'
          + 'if(!r.ok){console.error("ERROR: "+r.reason);process.exit(1)}'
          + 'const f=identityFacts("/state");'
          + 'console.log("MINERAL "+JSON.stringify({mineral_id:f.mineral_id,holder:f.holder,access:f.access,tier:f.tier,anchor:f.anchor}));'
          + 'console.log(r.already?"OK: already yours":"OK: this mineral is now recorded as yours")\' "$tmp"; '
          + 'rc=$?; rm -f "$tmp"; exit $rc',
        stdin: b64 + '\n',
      };
    },
  },
  // The cheap read: who does this mineral say it belongs to, and what is its
  // serial? Never mutates, so the app can ask every mineral on every launch.
  'mineral-identity': {
    build: () => ({
      command: '[ -f /app/engine/lib/mineral-identity.mjs ] || { echo "NOIDENTITY"; exit 0; }; '
        + 'node --input-type=module -e \'const {identityFacts}=await import("/app/engine/lib/mineral-identity.mjs");'
        + 'console.log("MINERAL "+JSON.stringify(identityFacts("/state")))\'',
    }),
  },
  // ---- anchor wiring, mineral side (T7, 2026-08-10) -------------------------
  // anchor-pubkeys: the cheap read — is this mineral already wired to <org>,
  // and if so, what are its PUBLIC key halves? Lets the app re-relay lost
  // posts without spending the one-time bundle claim.
  'anchor-pubkeys': {
    build: (a = {}) => {
      const org = String(a.org ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(org)) bad('that does not look like a rock handle');
      return {
        command: 'set -e; '
          + 'if [ -f /state/org-inbox.conf ] && [ -f /state/org-contact.json ] '
          + '&& node -e \'try{const c=JSON.parse(require("fs").readFileSync("/state/org-contact.json","utf8"));process.exit(String(c.org||"")===process.argv[1]?0:1)}catch{process.exit(1)}\' \'' + org + '\' '
          + '&& [ -f /state/secrets/org_inbox_deploy_key.pub ] && [ -f /state/secrets/heartbeat_deploy_key.pub ]; then '
          + 'echo "PUBKEYS $(node -e \'const f=require("fs");process.stdout.write(JSON.stringify({inbox_pub:f.readFileSync("/state/secrets/org_inbox_deploy_key.pub","utf8").trim(),heartbeat_pub:f.readFileSync("/state/secrets/heartbeat_deploy_key.pub","utf8").trim()}))\')"; '
          + 'else echo "NOTWIRED"; fi',
      };
    },
  },
  // anchor-wire: apply a claimed wire bundle. Mints BOTH deploy keypairs ON
  // THIS MINERAL (private halves never leave — re-anchor-apply's rule), writes
  // the channel confs + the org contact card, flips ownership.json's anchor,
  // and prints the public halves for the app to relay. Refusals in words:
  // an org-owned mineral is wired by its org; a mineral already carrying
  // ANOTHER rock's channel must leave it first. Idempotent for the same org.
  'anchor-wire': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 20000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~15 KB)');
      return {
        command: 'set -e; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          // validate + explode the bundle into a sourceable env file
          + 'vars="$(mktemp)"; node -e \''
          + 'const fs=require("fs");let b;try{b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(2)};'
          + 'const org=String(b.org||"");const bu=b.bundle||{};'
          + 'const ir=String(bu.inbox_repo||"");const hr=String(bu.heartbeat_repo||"");'
          + 'if(!/^[a-z0-9][a-z0-9-]{0,30}$/.test(org))process.exit(2);'
          + 'if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\\/inbox-[a-z0-9-]{1,40}$/.test(ir))process.exit(2);'
          + 'if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\\/heartbeat-[a-z0-9-]{1,40}$/.test(hr))process.exit(2);'
          + 'const owner=ir.split("/")[0];const slug=ir.split("/")[1].replace(/^inbox-/,"");'
          + 'if(hr!==owner+"/heartbeat-"+slug)process.exit(2);'
          + 'const q=(s)=>"\\x27"+String(s).replace(/\\x27/g,"")+"\\x27";'
          + 'fs.writeFileSync(process.argv[2],"WORG="+q(org)+"\\nWOWNER="+q(owner)+"\\nWSLUG="+q(slug)+"\\n");'
          + 'fs.writeFileSync(process.argv[2]+".contact",JSON.stringify(Object.assign({},(bu.org_contact&&typeof bu.org_contact==="object")?bu.org_contact:{},{org:org}))+"\\n");'
          + '\' "$tmp" "$vars" || { rm -f "$tmp" "$vars"; echo "ERROR: that wire bundle does not parse; nothing was changed"; exit 1; }; '
          + '. "$vars"; '
          // refusal 1: an org-owned mineral is not the member's to wire
          + 'if [ -f /state/ownership.json ] && node -e \'try{const o=JSON.parse(require("fs").readFileSync("/state/ownership.json","utf8"));process.exit(String(o.owner||"member")==="member"?1:0)}catch{process.exit(1)}\'; then '
          + 'rm -f "$tmp" "$vars" "$vars.contact"; echo "ERROR: this mineral is org-owned; its org wires it, not an anchor claim"; exit 1; fi; '
          // refusal 2: a channel for ANOTHER rock is already here
          + 'if [ -f /state/org-inbox.conf ]; then . /state/org-inbox.conf; '
          + 'if [ "$ORG_GH_OWNER" != "$WOWNER" ] || [ "$SLUG" != "$WSLUG" ]; then '
          + 'rm -f "$tmp" "$vars" "$vars.contact"; echo "ERROR: this mineral already carries a channel for $ORG_GH_OWNER ($SLUG); leave that rock before anchoring to another"; exit 1; fi; fi; '
          // mint (idempotent: existing keys are kept, .pub halves preserved)
          + 'mkdir -p /state/secrets; '
          + '[ -f /state/secrets/org_inbox_deploy_key ] || ssh-keygen -q -t ed25519 -N "" -C "inbox-$WSLUG" -f /state/secrets/org_inbox_deploy_key; '
          + '[ -f /state/secrets/heartbeat_deploy_key ] || ssh-keygen -q -t ed25519 -N "" -C "heartbeat-$WSLUG" -f /state/secrets/heartbeat_deploy_key; '
          + 'chmod 600 /state/secrets/org_inbox_deploy_key /state/secrets/heartbeat_deploy_key; '
          // the channel confs + the contact card (NEVER the org pull token: 2026-08-20 audit)
          + 'printf "ORG_GH_OWNER=%s\\nSLUG=%s\\nPULSE_SHEET_ID=\\n" "$WOWNER" "$WSLUG" > /state/org-inbox.conf; '
          + 'printf "ORG_GH_OWNER=%s\\nSLUG=%s\\n" "$WOWNER" "$WSLUG" > /state/heartbeat.conf; '
          + 'mv "$vars.contact" /state/org-contact.json; '
          // The org's admin credential is not stored here and never was read here.
          // Holding it IS being the org, so a copy left by an older build is cleared.
          + 'rm -f /state/secrets/org_pull_token; '
          // the anchor record: this mineral now hangs off that rock
          + 'node -e \'const fs=require("fs");let o={};try{o=JSON.parse(fs.readFileSync("/state/ownership.json","utf8"))}catch{o={tier:"pebble",owner:"member"}};o.anchor=process.argv[1];fs.writeFileSync("/state/ownership.json",JSON.stringify(o,null,2)+"\\n")\' "$WORG"; '
          + 'rm -f "$tmp" "$vars"; '
          + 'echo "OK: wired to $WORG ($WOWNER). The channel starts pulling once the rock registers these keys:"; '
          + 'echo "PUBKEYS $(node -e \'const f=require("fs");process.stdout.write(JSON.stringify({inbox_pub:f.readFileSync("/state/secrets/org_inbox_deploy_key.pub","utf8").trim(),heartbeat_pub:f.readFileSync("/state/secrets/heartbeat_deploy_key.pub","utf8").trim()}))\')"',
        stdin: b64 + '\n',
      };
    },
  },
  'ties-write': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 20000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~15 KB)');
      return {
        command: 'set -e; tmp="$(mktemp)"; base64 -d > "$tmp"; '
          + 'node -e \'const fs=require("fs");const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'
          + 'if(!Array.isArray(rows)||rows.length>20)process.exit(1);'
          + 'const ok=rows.every(function(r){return r&&typeof r==="object"'
          + '&&/^[a-z0-9][a-z0-9-]{0,30}$/.test(String(r.org||""))'
          + '&&["joined","anchored"].indexOf(String(r.tie||""))>=0'
          + '&&String(r.org_display||"").length<=80&&String(r.status||"").length<=20});'
          + 'if(!ok)process.exit(1);'
          + 'fs.writeFileSync("/state/ties.json",JSON.stringify({updated:new Date().toISOString(),'
          + 'ties:rows.map(function(r){return{org:String(r.org),org_display:String(r.org_display||""),tie:String(r.tie),status:String(r.status||"active")}})},null,1))\' "$tmp" '
          + '|| { rm -f "$tmp"; echo "ERROR: ties payload rejected, nothing saved"; exit 1; }; '
          + 'rm -f "$tmp"; echo "OK: ties recorded"',
        stdin: b64 + '\n',
      };
    },
  },

  // The Map's three probes in ONE exec (2026-08-09 lag audit): the map polls
  // every 20s and each probe was its own SSH round-trip, which saturated the
  // bridge's concurrency slots. Marker-split app-side; the auxiliary legs stay
  // additive (|| true), so a probe that will not answer costs its nodes,
  // never the map.
  'topology-state': {
    build: () => ({
      command: MEMBER_VERBS['member-console-state'].build().command
        + '; echo "__DEVICES__"; { ' + MEMBER_VERBS['devices-list'].build().command + '; } 2>/dev/null || true'
        + '; echo "__SUPPORT__"; { ' + MEMBER_VERBS['support-status'].build().command + '; } 2>/dev/null || true',
    }),
  },

  // Slice 2 (2026-08-03): answer a rock's ask from the pebble's own seat.
  // Runs ON the box: records the answer locally (clears the card) and
  // publishes it up the heartbeat repo, the same channel transfer-accept
  // uses, where the rock's ask-answers-reconcile applies it. Both writes are
  // the box's own; nothing here needs the rock's cooperation to say no.
  'ask-answer': {
    mutating: true,
    build: (a = {}) => {
      const kind = String(a.kind ?? '');
      if (!['ask-read', 'ask-install', 'reframe'].includes(kind)) bad('kind must be ask-read, ask-install or reframe');
      const answer = String(a.answer ?? '');
      if (answer !== 'accepted' && answer !== 'declined') bad('answer must be accepted or declined');
      return {
        command: 'set -e; ASK=/state/org-inbox/asks/' + kind + '.json; '
          + '[ -f "$ASK" ] || { echo "ERROR: there is no open ' + kind + ' ask on this mineral (it may have been withdrawn)."; exit 1; }; '
          + 'mkdir -p /state/asks; '
          + 'node -e \'const fs=require("fs");const ask=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'
          // ts (full ISO) is the reconcile's dedupe key; `at` stays for display.
          // Date alone meant a same-day change of mind (declined 09:00, accepted
          // 14:00) was swallowed as already-applied.
          + 'const out={kind:"' + kind + '",answer:"' + answer + '",at:new Date().toISOString().slice(0,10),ts:new Date().toISOString(),asked:ask.asked||"",'
          + 'framework:ask.framework||"",intensity:ask.intensity||""};'
          + 'fs.writeFileSync("/state/asks/' + kind + '-answer.json",JSON.stringify(out)+"\\n")\' "$ASK"; '
          + 'if [ -f /state/heartbeat.conf ] && [ -f /state/secrets/heartbeat_deploy_key ] && [ -f /state/org-inbox.conf ]; then '
          + '. /state/org-inbox.conf; W=/state/.ask-answer; rm -rf "$W"; '
          + 'export GIT_SSH_COMMAND="ssh -i /state/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"; '
          + 'git clone -q --depth 1 "${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}" "$W"; '
          + 'mkdir -p "$W/asks"; cp /state/asks/' + kind + '-answer.json "$W/asks/' + kind + '-answer.json"; '
          + 'cd "$W"; git add asks/; git -c user.name=mineral -c user.email=mineral@mineral.local commit -q -m "ask-answer: ' + kind + ' ' + answer + '" 2>/dev/null || true; '
          + 'git push -q origin HEAD; rm -rf "$W"; '
          + 'echo "OK: your answer (' + answer + ') is recorded and on its way to the rock."; '
          + 'else echo "OK: your answer (' + answer + ') is recorded on this mineral. No rock channel exists to carry it further."; fi',
      };
    },
  },

  // Slice 2 (2026-08-03): "leaving never needs permission". The pebble leaves
  // its home rock unilaterally: a typed confirm arms it, the box publishes the
  // leave marker up the heartbeat, and the rock's leave-reconcile flips the
  // row + detaches its door key on its next console read. Effective
  // immediately on the pebble's side; the mineral and brain stay the person's.
  'leave-org': {
    mutating: true,
    build: (a = {}) => {
      if (String(a.confirm ?? '') !== 'leave') bad('to arm this, type the word leave exactly');
      return {
        command: 'set -e; '
          + '[ -f /state/org-inbox.conf ] || { echo "ERROR: this mineral is not anchored to a rock; there is nothing to leave."; exit 1; }; '
          + '[ -f /state/heartbeat.conf ] && [ -f /state/secrets/heartbeat_deploy_key ] || { echo "ERROR: no rock channel exists on this mineral to carry the leave."; exit 1; }; '
          + '. /state/org-inbox.conf; '
          + 'node -e \'const fs=require("fs");fs.writeFileSync("/state/left.json",JSON.stringify({left:new Date().toISOString().slice(0,10),by:"member"})+"\\n")\'; '
          + 'W=/state/.leave; rm -rf "$W"; '
          + 'export GIT_SSH_COMMAND="ssh -i /state/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"; '
          + 'git clone -q --depth 1 "${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}" "$W"; '
          + 'node -e \'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/leave.json",JSON.stringify({at:new Date().toISOString().slice(0,10),by:"member"})+"\\n")\' "$W"; '
          + 'cd "$W"; git add leave.json; git -c user.name=mineral -c user.email=mineral@mineral.local commit -q -m "leave: member left" 2>/dev/null || true; '
          + 'git push -q origin HEAD; rm -rf "$W"; '
          // THE DETACH, and it has to be here rather than earlier: the push above
          // needs the very credentials this removes. Before it existed, leaving
          // wrote two markers and changed nothing — the hourly heartbeat and the
          // two-minute org-sync kept running against the rock's repos, so
          // a member who had left kept sending status metadata to them
          // indefinitely, and every screen still read as anchored because nothing
          // on the box has ever read left.json. Both jobs self-guard on their conf
          // and exit 0 without it, so removing the confs IS the detach; the
          // re-anchor is what makes the seat, the Library and the promote gate
          // read correctly, exactly as eviction already does.
          + 'rm -f /state/heartbeat.conf /state/org-inbox.conf /state/org-contact.json; '
          + 'rm -f /state/secrets/heartbeat_deploy_key /state/secrets/org_inbox_deploy_key; '
          + 'node -e \'const fs=require("fs");const f="/state/ownership.json";'
          + 'try{const j=JSON.parse(fs.readFileSync(f,"utf8"));j.anchor="crads-ai";'
          + 'fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")}catch(e){}\'; '
          + 'echo "OK: you have left. Your mineral has stopped talking to them: the status updates stop now, and this mineral is anchored to Crads AI again. They see the leave in their own records. Your mineral and your brain stay yours, and rejoining is always an invite away."',
      };
    },
  },

  // The RECEIPT comes from POST /transfer-consent (the member's own sign-in,
  // recorded at the directory). The script refuses without one, so a support
  // session on the box cannot accept a transfer on the member's behalf; the
  // org's completer then checks the same record before it flips owner.
  'transfer-accept': {
    mutating: true,
    build: (a = {}) => {
      const receipt = String(a.receipt || '');
      if (!/^[0-9a-f]{32}$/.test(receipt)) bad('accepting a transfer needs your consent receipt: sign in and press Accept in the app');
      // The IMAGE copy (/state/transfer-accept.sh, installed by box-up.sh on
      // every start, so it carries the receipt gate fleet-wide) is preferred;
      // the inbox copy the rock pushed with the invitation is the fallback for
      // a box that has not restarted onto the new image yet.
      return {
        command: '[ -f /state/org-inbox/transfer/to-org.json ] '
          + '|| { echo "No transfer invitation from your rock."; exit 0; }; '
          + 'S=/state/transfer-accept.sh; [ -f "$S" ] || S=/state/org-inbox/transfer/transfer-accept.sh; '
          + '[ -f "$S" ] || { echo "No transfer invitation from your rock."; exit 0; }; '
          + 'bash "$S" /state ' + receipt,
      };
    },
  },

  // D55 update channel, member edition: the member restarts their OWN box (their
  // VM, their choice — self-heal + updates in one). What arrives is bounded by
  // policy, not by this button: the box only ever pulls the image tag the org
  // pinned at stamp time (lifecycle_images consent lives in WHERE the tag
  // points, decided org-side), so a member can never leapfrog their org.
  // Nothing auto-restarts a member box; this verb is the only trigger.
  'box-refresh': {
    mutating: true,
    build: () => ({
      command: 'echo "Restarting your assistant\'s mineral. It picks up the software version your rock has published for it; your brain and files stay put."; '
        + '(sleep 2; kill 1) </dev/null >/dev/null 2>&1 & '
        + 'echo "OK: restart scheduled. Your assistant is back in about a minute."',
    }),
  },
  // What is actually running, so Update-and-restart can be VERIFIED instead of
  // trusted (2026-08-09, Sam: "I don't think the button works properly" — and as
  // built it was unfalsifiable: the kill can be ignored and the image pull can
  // fail while the unit boots the cached image, and the button said "OK" in
  // every case). host = the container id, so a restart is visible even when the
  // software did not change; commit = the running /app checkout when the image
  // carries .git, else empty.
  // The folder Claude Code opens (R18, 2026-08-23): the name of the
  // mineral-named link inside /state, written by engine/lib/open-folder.mjs on
  // every boot. Answers `state` on a box that has not written it yet (born
  // before R18, image not yet updated), which the app maps to plain /state.
  // The Help copy reads this to say "pick the folder called <name>". Same
  // command as claude-settings.mjs OPEN_FOLDER_PROBE, so every reader agrees.
  'open-folder': {
    build: () => ({ command: 'cat /state/open-folder 2>/dev/null || echo state' }),
  },

  'box-version': {
    build: () => ({
      command: 'printf \'{"host":"%s","commit":"%s","up":"%s"}\\n\' '
        + '"$(hostname)" "$(git -C /app rev-parse --short HEAD 2>/dev/null || true)" "$(ps -o etime= -p 1 2>/dev/null | tr -d \' \' || true)"',
    }),
  },

  // ---- app shell (three-layer model, L3): what the app renders beyond the
  // built-in tabs lives ON THE BOX under /state/dashboard/, seeded from engine
  // templates on first read and member-owned after that. One round trip carries
  // the page manifest, the config-level card overrides, the L2 ownership
  // record, and the org contact (creator-door: admin email push-down, staged
  // by factory/stamp-pebble.sh alongside ownership.json); page fragments load
  // on demand via page-read.
  'pages-list': {
    build: () => ({
      command: 'node /app/engine/appshell/seed-pages.mjs /state >/dev/null 2>&1 || true; '
        + 'echo "__MANIFEST__"; cat /state/dashboard/pages.json 2>/dev/null || echo "{}"; '
        + 'echo "__CARDS__"; cat /state/dashboard/cards.json 2>/dev/null || echo "{}"; '
        + 'echo "__OWNERSHIP__"; cat /state/ownership.json 2>/dev/null || echo "{}"; '
        + 'echo "__ORGCONTACT__"; cat /state/org-contact.json 2>/dev/null || echo "{}"',
    }),
  },
  // Prompts (spec 2026-08-25 § 5.2): the copyable text a rock offers this box.
  // Read-only and never installed: prompts are inert, so org-sync leaves them
  // in the inbox and this reads them there. Old images have no script, which
  // is a dormant state and not an error, exactly as catalog-list treats a
  // missing skills-list.mjs.
  'prompt-list': {
    build: () => ({
      command: 'node /app/engine/appshell/prompts-list.mjs /state 2>/dev/null '
        + '|| echo \'PROMPTS_STATE {"prompts":[],"dormant":"this box needs an update before it can show prompts"}\'',
    }),
  },
  // Files (spec 2026-08-25 § 5.4): the directories this box has installed.
  // Read-only; the index is the record and this never touches the trees it
  // names. Old images have no script, which is a dormant state and not an
  // error, exactly as prompt-list and catalog-list treat a missing one.
  'library-list': {
    build: () => ({
      command: BR_RESOLVE + 'node /app/engine/appshell/library-list.mjs "$BR" 2>/dev/null '
        + '|| echo \'LIBRARY_STATE {"dirs":[],"dormant":"this box needs an update before it can show your library"}\'',
    }),
  },
  'page-read': {
    build: (a = {}) => {
      const p = String(a.page ?? '');
      if (!/^[a-z0-9][a-z0-9._-]{0,80}\.html$/.test(p) || p.includes('..')) bad('page must be a plain <slug>.html filename');
      return { command: `cat /state/dashboard/pages/${p}` };
    },
  },
  // Panel iteration 2, R15 (2026-08-23): a page can be removed from the app,
  // seeded examples included. Removes the fragment AND the manifest entry via
  // engine/appshell/page-delete.mjs; an image too old to carry the script says
  // so rather than pretending. Output: `OK: page <id> deleted.` or `ERROR: ...`.
  'page-delete': {
    mutating: true,
    build: (a = {}) => {
      const id = String(a.id ?? '');
      if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id) || id.includes('..')) bad('id must be a plain page slug');
      return {
        command: 'S=/app/engine/appshell/page-delete.mjs; '
          + `if [ -f "$S" ]; then node "$S" /state ${id}; else echo "ERROR: this mineral's software is too old to delete pages; update and restart it first."; fi`,
      };
    },
  },

  // ---- communities (the commons-repo model, self-host pivot 2026-09-01) ----
  // A community is a rock's commons: a plain git repo the member's box pulls
  // read-only into org-inbox.d/<org>/, where every pickup surface already
  // reads. Joining is pasting a cradscommons1: bundle; the bundle rides STDIN
  // (never the command string, the community-blurb lesson), is shallow-checked
  // here for a fast honest refusal, and is re-parsed authoritatively box-side
  // by community-join.mjs. Nothing from a commons ever runs on pull; install
  // stays the member's act through the existing catalogue verbs.
  'community-list': {
    build: () => ({
      command: 'S=/app/engine/community/community-list.mjs; [ -f "$S" ] '
        + '&& node "$S" /state '
        + '|| echo \'COMMUNITIES_STATE {"communities":[],"dormant":"this box needs an update before it can show communities"}\'',
    }),
  },
  'community-join': {
    mutating: true,
    build: (a = {}) => {
      const bundle = String(a.bundle ?? '').trim();
      const shallow = checkJoinBundle(bundle);
      if (!shallow.ok) bad(shallow.error);
      return {
        command: 'S=/app/engine/community/community-join.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this mineral\'s software is too old to join communities; update and restart it first."; exit 1; }; '
          + 'node "$S" /state',
        stdin: bundle + '\n',
      };
    },
  },
  'community-leave': {
    mutating: true,
    build: (a = {}) => {
      const org = String(a.org ?? '');
      if (!COMMONS_ORG_RE.test(org)) bad('org must be the community name shown on the Communities page');
      return {
        command: 'S=/app/engine/community/community-leave.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this mineral\'s software is too old to manage communities; update and restart it first."; exit 1; }; '
          + `node "$S" /state ${org}`,
      };
    },
  },
  // Share-back rides the git host's own PR flow; this only stages files on the
  // box and prints the steps. Read-only from the commons' point of view.
  'community-share': {
    build: (a = {}) => {
      const org = String(a.org ?? '');
      const kind = String(a.kind ?? '');
      const id = String(a.id ?? '');
      if (!COMMONS_ORG_RE.test(org)) bad('org must be the community name shown on the Communities page');
      if (!['skill', 'page', 'dir'].includes(kind)) bad('kind must be skill, page or dir');
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) bad('id must be a kebab-case name');
      return {
        command: 'S=/app/engine/community/commons-share.mjs; [ -f "$S" ] '
          + '|| { echo "ERROR: this mineral\'s software is too old to prepare a share; update and restart it first."; exit 1; }; '
          + BR_RESOLVE + `node "$S" /state "$BR" ${org} ${kind} ${id}`,
      };
    },
  },

  // ---- consent-gated support access (three-layer model, L1 repair): the member
  // grants Crads AI a time-boxed SSH window into THEIR box; sshd's own
  // expiry-time option enforces the deadline, revoke strips it instantly, and
  // the grant lifecycle is logged member-readably in /state/support/access.json.
  // No grant, no access — there is no standing vendor key on a member box.
  'support-status': {
    build: () => ({ command: 'node /app/engine/support/support-access.mjs /state status' }),
  },
  'support-grant': {
    mutating: true,
    build: (a = {}) => {
      const hours = parseInt(a.hours, 10);
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) bad('hours must be 1-72');
      return { command: `node /app/engine/support/support-access.mjs /state grant ${hours}` };
    },
  },
  'support-revoke': {
    mutating: true,
    build: () => ({ command: 'node /app/engine/support/support-access.mjs /state revoke' }),
  },

  // ---- the secret store (2026-07-28 design). Two tiers, and the tier is a fact
  // about the box rather than a preference: HOT means a scheduled job needs the
  // value at 3am, so the box must be able to read it (and Crads AI could too, with
  // server access; the app says so). COLD means it is sealed on the MEMBER's
  // machine to their devices' vault keys, so the box stores an envelope it has no
  // key for. The value rides STDIN as base64, never argv: argv would land in the
  // process list and any command log, which is the mistake this feature exists to
  // stop. `secrets-list` never carries values.
  'secrets-list': {
    build: () => ({ command: 'node /app/engine/vault/vault-cli.mjs /state list' }),
  },
  'secrets-envelopes': {
    build: () => ({ command: 'node /app/engine/vault/vault-cli.mjs /state envelopes' }),
  },
  // Credentials on the box that the vault does not manage. Read-only by
  // construction: discover.mjs emits names, locations and a set/not-set boolean,
  // and has no code path that returns a value.
  'secrets-discover': {
    build: () => ({ command: 'node /app/engine/vault/vault-cli.mjs /state discover' }),
  },
  'secrets-put': {
    mutating: true,
    build: (a = {}) => {
      const name = secretNameArg(a.name);
      const label = shq(a.label || name, 'label', 60);
      const tier = String(a.tier ?? '');
      if (!['hot', 'cold'].includes(tier)) bad('tier must be hot or cold');
      const b64 = String(a.content_b64 ?? '');
      if (!b64 || b64.length > 200000 || !B64_RE.test(b64)) bad('content_b64 must be base64 (max ~150 KB)');
      return {
        command: `base64 -d | node /app/engine/vault/vault-cli.mjs /state put-${tier} ${name} ${label}`,
        stdin: b64 + '\n',
      };
    },
  },
  'secrets-remove': {
    mutating: true,
    build: (a = {}) => ({ command: `node /app/engine/vault/vault-cli.mjs /state remove ${secretNameArg(a.name)}` }),
  },

  // ---- Telegram, linkable from the app (2026-08-05) -----------------------
  // The capability was always there (engine/connect-telegram.sh) and completely
  // unreachable: it is an interactive shell script inside the box, so the app
  // could report "ready to link" and offer no way to link. The Telegram row's
  // button flipped you to the Claude Code tab and left you to find a terminal.
  //
  // Each member keeps their OWN bot. One shared Crads-AI bot would be a single
  // tap, and would also route every member's messages through our infrastructure
  // and make us hold every box's token. The box long-polls Telegram itself, so
  // nothing of theirs passes through us.
  'telegram-status': {
    build: () => ({ command: 'node /app/engine/comms/telegram-link.mjs /state status' }),
  },
  // The token arrives base64 on STDIN and is never an argv value: argv is visible
  // in `ps` to anything else on the box, and the script never returns it either.
  'telegram-verify': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.token_b64 ?? '');
      if (!b64 || b64.length > 400 || !B64_RE.test(b64)) bad('token_b64 must be base64 (a bot token, nothing larger)');
      // NO `base64 -d` here: the script decodes its own stdin. The pipe decoded
      // it FIRST, so the script's decode then ran on the raw token and produced
      // garbage — every real paste failed shape validation while the tests (which
      // call the script directly) stayed green. Found 2026-08-09.
      return { command: 'node /app/engine/comms/telegram-link.mjs /state verify', stdin: b64 + '\n' };
    },
  },
  // One poll per call, so the app can keep asking while the member goes and
  // messages their bot, without a verb sitting on an open channel for minutes.
  'telegram-link': {
    mutating: true,
    build: () => ({ command: 'node /app/engine/comms/telegram-link.mjs /state link' }),
  },
  'telegram-forget': {
    mutating: true,
    build: () => ({ command: 'node /app/engine/comms/telegram-link.mjs /state forget' }),
  },

  // ---- MCP connections, visible and changeable (2026-08-05) ----------------
  // Connecting Gmail in the Claude Code app connects it to the member's CLAUDE
  // ACCOUNT, which reaches interactive sessions only, so their scheduled jobs
  // stayed blind while the app said it was connected. These verbs point the BOX
  // at the same endpoints as its own project-scoped servers, which a headless run
  // does load, and surface the real state of each one.
  // GUARDED on the file existing, because the two halves of this feature update on
  // different clocks: the app republishes minutes after a push, the box image only
  // on a deliberate promote plus a restart the member has to choose. So there is
  // always a window where a new verb names a script the running box does not have,
  // and unguarded that window shows the member a raw MODULE_NOT_FOUND stack trace
  // (it showed Sam one). An old box is a knowable state, not an error.
  'mcp-status': {
    build: () => ({
      command: '[ -f /app/engine/comms/mcp-connect.mjs ] '
        + '&& node /app/engine/comms/mcp-connect.mjs /state status '
        + '|| echo \'{"ok":false,"error":"box-too-old"}\'',
    }),
  },
  'mcp-add': {
    mutating: true,
    build: (a = {}) => ({
      command: `[ -f /app/engine/comms/mcp-connect.mjs ] `
        + `&& node /app/engine/comms/mcp-connect.mjs /state add ${mcpKeyArg(a.key)} `
        + `|| echo '{"ok":false,"error":"box-too-old"}'`,
    }),
  },
  'mcp-remove': {
    mutating: true,
    build: (a = {}) => ({
      command: `[ -f /app/engine/comms/mcp-connect.mjs ] `
        + `&& node /app/engine/comms/mcp-connect.mjs /state remove ${mcpKeyArg(a.key)} `
        + `|| echo '{"ok":false,"error":"box-too-old"}'`,
    }),
  },
  // Connect anything with an MCP server (Sam's ruling 2026-08-09). The definition
  // rides stdin as base64(JSON) — the URL is member input and the optional API
  // token is a secret, so neither belongs in argv. NO `base64 -d` in the pipe:
  // the script decodes its own stdin (see the telegram-verify double-decode bug).
  'mcp-add-custom': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.def_b64 ?? '');
      if (!b64 || b64.length > 12000 || !B64_RE.test(b64)) bad('def_b64 must be base64 (a small JSON definition)');
      return {
        command: `[ -f /app/engine/comms/mcp-connect.mjs ] `
          + `&& node /app/engine/comms/mcp-connect.mjs /state add-custom `
          + `|| echo '{"ok":false,"error":"box-too-old"}'`,
        stdin: b64 + '\n',
      };
    },
  },
  // A chats-only Claude Code connection (local/user scope, which headless runs
  // never load) moves into project scope, where jobs DO load it. One click on
  // the page; the existing sign-in survives the move.
  'mcp-adopt': {
    mutating: true,
    build: (a = {}) => ({
      command: `[ -f /app/engine/comms/mcp-connect.mjs ] `
        + `&& node /app/engine/comms/mcp-connect.mjs /state adopt ${mcpKeyArg(a.key)} `
        + `|| echo '{"ok":false,"error":"box-too-old"}'`,
    }),
  },
  // Where an OAuth result LANDS. The app does the flow and hands the box the
  // token; this is the only writer, so the header in .mcp.json and the refresh
  // store can never disagree about what a connection currently is.
  'mcp-token-set': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.payload_b64 ?? '');
      if (!b64 || b64.length > 20000 || !B64_RE.test(b64)) bad('payload_b64 must be base64 (a token record)');
      return {
        command: `[ -f /app/engine/comms/mcp-token.mjs ] `
          + `&& node /app/engine/comms/mcp-token.mjs /state set `
          + `|| echo '{"ok":false,"error":"box-too-old"}'`,
        stdin: b64 + '\n',
      };
    },
  },
  'mcp-token-forget': {
    mutating: true,
    build: (a = {}) => ({
      command: `[ -f /app/engine/comms/mcp-token.mjs ] `
        + `&& node /app/engine/comms/mcp-token.mjs /state forget ${mcpKeyArg(a.key)} `
        + `|| echo '{"ok":false,"error":"box-too-old"}'`,
    }),
  },
  // BYO Google (docs/design-google-byo-connect.md, 2026-08-17). Two verbs, one
  // sensitivity split: add-google carries only the member's email (the server
  // DEFINITION), token-set-google carries the whole credential record (their
  // own client id + secret + tokens), so it rides stdin as base64 like every
  // secret does. NO `base64 -d` in either pipe: both box scripts decode their
  // own stdin (the telegram-verify double-decode bug).
  'mcp-add-google': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.payload_b64 ?? '');
      if (!b64 || b64.length > 2000 || !B64_RE.test(b64)) bad('payload_b64 must be base64 (an email, nothing larger)');
      return {
        command: `[ -f /app/engine/comms/mcp-connect.mjs ] `
          + `&& node /app/engine/comms/mcp-connect.mjs /state add-google `
          + `|| echo '{"ok":false,"error":"box-too-old"}'`,
        stdin: b64 + '\n',
      };
    },
  },
  'mcp-token-set-google': {
    mutating: true,
    build: (a = {}) => {
      const b64 = String(a.payload_b64 ?? '');
      if (!b64 || b64.length > 20000 || !B64_RE.test(b64)) bad('payload_b64 must be base64 (a credential record)');
      return {
        command: `[ -f /app/engine/comms/mcp-token.mjs ] `
          + `&& node /app/engine/comms/mcp-token.mjs /state set-google `
          + `|| echo '{"ok":false,"error":"box-too-old"}'`,
        stdin: b64 + '\n',
      };
    },
  },
  // (The paste-back sign-in that drove `claude mcp login` lived here until
  // 2026-08-09. It is gone: the app now runs OAuth itself, so there is no CLI to
  // puppeteer, no terminal to fake, and no address for the member to copy.)

  // ---- the device roster (2026-07-28 design, phase 1): which computers can open
  // this box. The roster (devices/*.yaml, git-tracked in the member's own brain)
  // is the source of truth; it derives /state/ssh/member/authorized_keys, which
  // the host sshd serves per authentication attempt, so add and revoke are
  // instant with no host access and no reload. Support grants appear in the same
  // list because device-sync renders them into the same file.
  // Not adminOnly: this is the member's own box, and lifecycle authority rides
  // ownership (model reconciliation, ruling 1).
  'devices-list': {
    build: () => ({ command: 'node /app/engine/devices/roster-cli.mjs /state list' }),
  },
  'devices-add': {
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const label = shq(a.label, 'label', 60);
      const pubkey = pubkeyArg(a.pubkey);
      return { command: `node /app/engine/devices/roster-cli.mjs /state add ${slug} ${label} '${pubkey}'` };
    },
  },
  'devices-revoke': {
    mutating: true,
    build: (a = {}) => ({ command: `node /app/engine/devices/roster-cli.mjs /state revoke ${slugArg(a.slug)}` }),
  },
  // The Network heartbeat marks the device the app runs on as seen. Only its
  // own slug (from /devices/self-heal), never another device's: the row is a
  // presence fact, and this app can only speak for the machine it is on.
  'devices-stamp': {
    mutating: true,
    build: (a = {}) => ({ command: `node /app/engine/devices/roster-cli.mjs /state seen ${slugArg(a.slug)}` }),
  },
  'devices-rename': {
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const label = shq(a.label, 'label', 60);
      return { command: `node /app/engine/devices/roster-cli.mjs /state rename ${slug} ${label}` };
    },
  },
  // The device's X25519 vault PUBLIC half, published so cold secrets can be
  // sealed to it (secret-store design, 2026-07-28). Driven by the loopback
  // /vault/sync route, which mints the pair locally; only the public half
  // ever travels.
  // Rename (Sam, 2026-07-30): DISPLAY NAME ONLY. The slug, address, SSH host and
  // keys are untouched, so nothing breaks and no link dies — renaming is a label
  // change, not a migration. One line in /state/box-name; the surfaces read it
  // and fall back to the slug when absent.
  // PROMOTE: THE LOCAL VERB IS GONE (2026-08-10). It ran
  // engine/promote/seed-org.mjs on the box, and that script requires PLATFORM
  // GitHub credentials at /state/secrets/provisioning.env.local. A member box
  // has never had them (the member cloud-init stages no secrets file) and the
  // 2026-08-09 ownership ruling means it never will, so every press refused with
  // "no platform GitHub credentials on this box" and promotion was dead on every
  // pebble. It also bypassed the payment gate, so a working version of it would
  // have been worse than the broken one.
  //
  // Promotion is BROKERED and lives on the /promote/* routes below: pre-copy
  // verified on the box, request parked on the directory, approved + billed +
  // seeded operator-side by cockpit/jobs/fulfil-promotions.mjs, then flipped
  // here. seed-org.mjs survives as the operator-side seeding implementation and
  // must never be reachable from a member face again.

  'box-rename': {
    mutating: true,
    build: (a = {}) => {
      const name = String(a.name ?? '').trim();
      if (!name || name.length > 60) bad('a name needs 1 to 60 characters');
      if (/[\x00-\x1f\x7f]/.test(name)) bad('that name has characters we cannot store');
      // Both uses must stay SHELL WORDS. shq escapes single quotes and refuses
      // control characters, which makes it safe as a standalone word, but it does
      // not escape $ or backtick, so the old second use inside a DOUBLE-quoted
      // echo executed command substitution: name `x$(echo PWNED)` printed
      // "OK: renamed to 'xPWNED'" (verified). The file write was always fine; the
      // confirmation message was the hole. printf takes it as an argument instead,
      // so nothing is ever re-parsed. This was the only injectable argument on the
      // member face, and the panel has no auth, CSRF token or Origin check, so a
      // page the member merely visited could reach it.
      //
      // One name (2026-08-09): renaming the box renames the assistant. The
      // dual write (/state/box-name + profile.yaml identity.assistant_name)
      // lives in engine/box/name-set.mjs — the same script the box-up.sh
      // migration calls — so every writer shares one implementation and the
      // two files can never diverge again. The name travels as argv, never
      // re-parsed by a shell.
      return { command: `node /app/engine/box/name-set.mjs /state ${shq(name, 'name', 60)}` };
    },
  },
  'devices-set-vaultkey': {
    mutating: true,
    build: (a = {}) => {
      const slug = slugArg(a.slug);
      const vk = String(a.vaultkey ?? '');
      // an X25519 spki-der public half is ~60 base64 chars: one line, no spaces
      if (!/^[A-Za-z0-9+/]{40,120}={0,3}$/.test(vk)) bad('vaultkey must be the base64 X25519 public half, one line');
      return { command: `node /app/engine/devices/roster-cli.mjs /state set-vaultkey ${slug} ${vk}` };
    },
  },

  // Their own wiki, read-only.
  ...brainVerbs(memberBrainEnter),
};

// ---------------------------------------------------------------- server
// createPanelServer({ port, host, htmlText|htmlPath, bridge, wizardUrl, role,
//                     edition }) -> the listening http.Server.
//   bridge     injectable transport (tests); defaults to the system ssh bridge
//   wizardUrl  where "Set up another rock" goes (the co-running wizard)
//   role       'admin' (default) | 'support'   (org edition only)
//   edition    'org' (default) | 'member' (D44: member verb table, <slug>-box
//              hosts, member.html; roles are meaningless, one person one box)
export function createPanelServer(opts = {}) {
  const bridge = opts.bridge || systemBridge();
  // RULING 8 (spec 2026-08-13): the dashboard's header picker is the SAME list
  // as the door's start screen, from the same handler. Deliberately UNFILTERED
  // by edition -- the picker exists to switch BETWEEN minerals, so a rock face
  // must still see your pebbles and vice versa. Everything else in this file
  // filters by targetKind because it acts on the box being looked at; this
  // does not act, it lists.
  const inventory = inventoryRoutes({
    targets: () => bridge.targets(),
    accountModule: opts.accountModule,
    accountFetcher: opts.accountFetcher,
    directoryUrl: opts.directoryUrl,
  });
  const edition = opts.edition === 'member' ? 'member' : 'org';
  // Upgraded-pebble P2 (2026-08-09): the rock box is a pebble-plus, so the org
  // face runs the member SELF-MANAGEMENT verb families against its own rock
  // box: skills/cadence (org skills on a rhythm + the run ledger), telegram,
  // MCP connections, secrets (+ the operator device roster the vault leans on),
  // sharing and the verified restart's version read. Org VERBS spread LAST so
  // the org-pathed twins (brain-list/brain-read on /state/brain, box-refresh,
  // whoami) always win. Box-side coverage varies by image age; every one of
  // these degrades through the engine-too-old / honest-error rails, never a
  // false empty. NOT imported on purpose: member-console-state + the seat
  // verbs (the rock seat is governance), box-rename (the rock's name is
  // governance's display_name, one name with one owner).
  //
  // catalog-list/install WERE excluded, on the reasoning that "a rock's library
  // is the vendor catalog under Publishing". One-inbox removes exactly that
  // confusion, so the exclusion goes with it: the Catalogue page is what this
  // rock GIVES OUT, and catalog-list is what it RECEIVES from the rocks it is
  // tied to. Different lists, different directions. A rock is a box, it gets an
  // inbox from every rock it joins, and it picks up from that inbox like anyone
  // else. This is the need community-skill-apply used to meet by crossing the
  // wall; it is met by the ordinary installer now.
  const SELF_VERBS = ['cadence-list', 'cadence-write', 'skills-list', 'skill-run',
    'sharing-list', 'sharing-write', 'support-status', 'support-grant', 'support-revoke',
    'secrets-list', 'secrets-envelopes', 'secrets-discover', 'secrets-put', 'secrets-remove',
    'telegram-status', 'telegram-verify', 'telegram-link', 'telegram-forget',
    'mcp-status', 'mcp-add', 'mcp-remove', 'mcp-add-custom', 'mcp-adopt', 'mcp-token-set', 'mcp-token-forget',
    'mcp-add-google', 'mcp-token-set-google',
    'devices-list', 'devices-add', 'devices-revoke', 'devices-stamp', 'devices-rename', 'devices-set-vaultkey',
    // dashboard-data crossed the wall for the overview unification (2026-08-09
    // S3): box-cockpit.mjs detects the org brain itself and the org face
    // reads the same data spine the pebble always had. Non-mutating.
    'box-version', 'dashboard-data', 'open-folder',
    'catalog-list', 'catalog-install', 'skill-remove', 'skill-read',
    // Pages on rocks (panel iteration 2, R15): the rock box is seeded like a
    // pebble by boot-rock.sh, so the org face reads, lists and deletes its own
    // pages. page-delete is mutating, so it lands adminOnly here.
    'pages-list', 'page-read', 'page-delete', 'prompt-list', 'dir-remove', 'library-list',
    // (community-skill-apply used to cross the wall here, so a rock could
    // install from a rock it had joined. One-inbox retired it: a rock is a box,
    // it gets an inbox from every rock it is tied to, and it picks up from that
    // inbox with catalog-install like anyone else.)
  ];
  // Imported self-management verbs: mutating ones become adminOnly on the org
  // edition (the member face has no roles; the org face does, and a Support
  // sign-in must not write secrets/sharing/devices on the rock's own box).
  const ORG_VERBS = Object.assign(
    Object.fromEntries(SELF_VERBS.filter((k) => MEMBER_VERBS[k])
      .map((k) => [k, MEMBER_VERBS[k].mutating ? { ...MEMBER_VERBS[k], adminOnly: true } : MEMBER_VERBS[k]])),
    VERBS);
  const verbs = edition === 'member' ? MEMBER_VERBS : ORG_VERBS;
  const hostRe = edition === 'member' ? MEMBER_HOST_RE : HOST_RE;
  const targetKind = edition === 'member' ? 'member' : 'rock';
  // Host gate (promote ruling § 3): valid = present in the bridge's target list
  // for THIS edition AND (matches the edition's alias shape OR carries the
  // probe-set promoted flag — a promoted rock keeps its -box alias). The flag
  // travels on the target row, which only the server-side face probe writes;
  // request input can never mint one. Org teardown deliberately does NOT use
  // this gate: destroying a promoted box goes through demote and its guards.
  const validTarget = (host, targets) => targets.some((t) => t.host === host && (hostRe.test(host) || t.promoted));
  const role = String(opts.role || 'admin').toLowerCase() === 'support' ? 'support' : 'admin';
  const roleAssumed = !opts.role; // no explicit role given: staging default (Admin), shown as assumed
  // ONE shell for both editions (2026-08-09): panel.html is gone; the org face
  // is member.html with edition=org stamped at serve time.
  const html = () => (opts.htmlText ?? readFileSync(opts.htmlPath || join(HERE, 'member.html')));
  let busy = false; // one mutating verb at a time

  // ---- own-brain, ON THE SEAT (2026-08-05, Sam: "I just want to click a button and
  // connect to GitHub"). The flow used to live only on the member-connect wizard, so
  // the seat's Backup button was a hop to another surface headed "Connect to your mineral",
  // which is the page for someone who does not have one. Same routes, mounted here, so
  // the button runs the flow in place and never leaves the app. Member edition only:
  // an org console has no personal brain to make yours.
  const ownBrainTargets = () => { try { return (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { return []; } };
  const ownBrainRoute = createOwnBrainRoutes({
    opts,
    defaultHost: () => { const t = ownBrainTargets(); return t.length ? t[0].host : null; },
    // Reuses the same gate every other box-addressed route uses, so a caller cannot
    // name a host this app does not manage and have it dialled.
    resolveHost: (want) => (validTarget(want, ownBrainTargets()) ? want : null),
  });

  // ---- the ROCK's own GitHub, connected from the app (2026-08-10) ----------
  // Same device flow the seat has had since 2026-08-05, pointed at the rock. It
  // exists because a door-born rock cannot stamp a pebble until its owner
  // connects an account they own, and the only way to do that was a terminal
  // command. Org edition only: a member has no factory to arm.
  const orgGitHubRoute = createOrgGitHubRoutes({
    opts,
    state: {},
    // Same target gate every box-addressed route uses: the value becomes an ssh
    // destination, so it can only ever be a rock THIS app already manages.
    //
    // FINDING 199 (2026-08-17): this used to be `t[0].host`, unconditionally.
    // With ONE rock that is the selected rock by definition, and one rock is all
    // this flow was ever driven against. The day the picker held two, Connect
    // GitHub pressed while VIEWING institute-of-shenanigans ran the whole flow
    // (token install + backup) against qa-r2-gmail: the token landed on the
    // wrong rock, the green line truthfully named the wrong rock's repo, and
    // the card's status read (which does follow the picker) went on saying "No
    // offsite copy yet". Sam: "it appears to connect but doesn't register".
    // Every box-addressed surface follows the picker through /run's host field;
    // this one route ignored it.
    //
    // The page now names the mineral it is showing, and the same validTarget
    // gate own-brain's resolveHost uses decides. A named host this app does not
    // manage is REFUSED, never silently swapped for t[0]: the silent swap is
    // the bug. No host named (an older page) keeps the old single-rock
    // behaviour.
    host: (want) => {
      const t = ownBrainTargets();
      if (!t.length) return null;
      if (want) return validTarget(want, t) ? want : null;
      return t[0].host;
    },
  });

  // ---- MCP sign-in, run by THIS app (2026-08-09) ---------------------------
  // The listener lives here, on the member's own machine, which is the whole
  // point: the CLI's listener ran on the BOX, unreachable from their browser,
  // which is why the old flow ended on a dead localhost page and needed a paste.
  // The token goes to the box the same way every other write does, as a verb
  // over the existing SSH channel, base64 on stdin so it never touches argv.
  const mcpOAuthRoute = createMcpOAuthRoutes({
    sendToBox: async (host, payload) => {
      const targets = (() => { try { return (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { return []; } })();
      const h = validTarget(host, targets) ? host : (targets[0] && targets[0].host);
      if (!h) throw new Error('this app is not connected to a mineral');
      const spec = MEMBER_VERBS['mcp-token-set'].build({
        payload_b64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      });
      const r = await runCollect(h, spec);
      // The box is the only place that can confirm the token landed; a silent
      // failure here would leave the browser saying "Connected" over nothing.
      if (r.code !== 0 || !/\"ok\":true/.test(String(r.out))) {
        throw new Error(`the mineral did not store it: ${String(r.out).slice(-160)}`);
      }
    },
  });

  // ---- BYO Google, run by THIS app (2026-08-17) ----------------------------
  // Google refuses dynamic client registration, so the generic /mcp-oauth flow
  // above can never complete against it. The member brings their own Desktop
  // client (docs/design-google-byo-connect.md); these routes parse the dropped
  // JSON, run the sign-in with THEIR client, and feed the box through the same
  // verb channel as every other write. The runner keeps sendToBox's stance: the
  // box is the only place that can confirm a write landed, so anything short of
  // code 0 + ok:true is a refusal, never a shrug.
  const googleConnectRoute = createGoogleConnectRoutes({
    opts: {
      runVerb: async (host, verb, args) => {
        const targets = (() => { try { return (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { return []; } })();
        const h = validTarget(host, targets) ? host : (targets[0] && targets[0].host);
        if (!h) throw new Error('this app is not connected to a mineral');
        const spec = MEMBER_VERBS[verb].build(args);
        const r = await runCollect(h, spec);
        if (r.code !== 0 || !/\"ok\":true/.test(String(r.out))) {
          throw new Error(`the mineral did not accept it: ${String(r.out).slice(-160)}`);
        }
        // The route needs the box's reply fields (email, rekey_due_at): the
        // reply is the last JSON line of the run's output.
        const line = String(r.out).split('\n').reverse().find((l) => l.trim().startsWith('{'));
        try { return JSON.parse(line); } catch { return { ok: true }; }
      },
    },
  });

  // The connections directory: catalogue, registry search, probe. All app-side;
  // the box is not involved until the member actually connects something.
  const mcpDirRoute = createMcpDirectoryRoutes({});

  // ---- the cold tier's member-side half (secret-store design, 2026-07-28).
  // Sealing and opening happen on THIS machine: the box only ever stores
  // envelopes it has no key for. These are loopback JSON routes rather than
  // verbs because each one composes box commands around a LOCAL crypto step
  // against the vault keypair beside the ssh identity (opts.sshDir injectable
  // for tests). Member edition only; plaintext never rides a box command.
  const sshDirOf = () => opts.sshDir || join(homedir(), '.ssh');
  const runCollect = (host, spec) => new Promise((resolve) => {
    const lines = [];
    let pebble;
    try {
      pebble = bridge.stream(host, spec.command, {
        onStdout: (l) => lines.push(l), onStderr: (l) => lines.push(l), stdin: spec.stdin,
      });
    } catch (e) { resolve({ code: 1, out: String(e.message || e) }); return; }
    pebble.on('error', (e) => resolve({ code: 1, out: String(e.message || e) }));
    pebble.on('close', (code) => resolve({ code: code ?? 1, out: lines.join('\n') }));
  });
  // R9 (2026-08-09 grilling): write the ties the app knows DOWN to each member
  // box, so the Network map (which reads only the box) can draw a tie made
  // after stamp time. Fired whenever fresh edges land (full refresh + the
  // silent 10-min repair); per-box filtering by slug keeps one owner's several
  // pebbles from wearing each other's ties.
  const syncTiesToBox = async (host, explicit) => {
    try {
      if (edition !== 'member') return;
      const st = server._communityMine || {};
      if (!Array.isArray(st.edges)) return;
      const slug = String(host).replace(/-box$/, '');
      const rows = st.edges
        .filter((x) => (x.rel === 'joined' || x.rel === 'anchored')
          // a platform lane is not a rock (PLATFORM_LANES): letting it into
          // ties.json made the Network map draw "crads-solo" as an anchored
          // community above a solo pebble
          && !PLATFORM_LANES.has(String(x.org || '').toLowerCase())
          // slug is the primary match; the edge's box host is the fallback the
          // T6 slug-reconciliation relies on (a collision renames the registry
          // slug, never the box)
          && (String(x.slug || '') === slug || String(x.box || '').indexOf(slug) === 0))
        .map((x) => ({ org: String(x.org || ''), org_display: String(x.org_display || ''),
          tie: x.rel, status: String(x.status || 'active') }));
      // E2 (2026-08-10 tie audit): never clobber a good ties.json with
      // emptiness — an empty read is indistinguishable from a broken one.
      // Only an explicit act (a leave) may clear the file.
      if (!rows.length && !explicit) return;
      const b64 = Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');
      await runCollect(host, MEMBER_VERBS['ties-write'].build({ content_b64: b64 }));
    } catch { /* the next edges refresh retries */ }
  };
  const syncTiesToAll = (explicit) => {
    let targets = [];
    try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
    targets.forEach((t) => { syncTiesToBox(t.host, explicit); });
  };
  // T5 (the account pass): the retained-token accessor. While a token is fresh
  // it is used as-is (Google or crads alike); when it ages out, the disk
  // session silently mints a new one, so the 50-minute ceiling stops being a
  // wall a member can hit mid-session. No session = null = the honest
  // sign-in-needed the routes already speak.
  const communityToken = async () => {
    const st = server._communityMine || (server._communityMine = {});
    if (st.idToken && Date.now() - (st.tokenAt || 0) < 50 * 60 * 1000) return st.idToken;
    // under the test runner only an INJECTED account mints (hermetic tests)
    if (!opts.accountToken && process.env.NODE_TEST_CONTEXT) return null;
    try {
      const mint = opts.accountToken || (await import('./crads-account.mjs')).getAppToken;
      const r = await mint({});
      if (r && r.ok && r.idToken) { st.idToken = r.idToken; st.tokenAt = Date.now(); return r.idToken; }
    } catch { /* sign-in-needed */ }
    return null;
  };
  // The 10-minute silent edge repair, one body two callers (finding 201):
  // /rock-mine has always run it (2026-08-09 lag audit; T5 lifted the
  // 50-minute ceiling), and orgTopologyWorld now needs the same freshness
  // because the rock's map draws the rock's own memberships from these
  // retained edges. Stamped first so parallel calls do not stampede.
  const ensureEdgesFresh = async () => {
    const st = server._communityMine || (server._communityMine = {});
    // SELF-HOST STRIP (2026-09-01): the central directory that held the edges
    // is deleted. Without an injected far end (tests, or a future commons
    // endpoint) there is nothing to refresh from: keep whatever edges are in
    // memory and never dial the dead host.
    if (!opts.directoryUrl && !opts.communityFetcher) return st;
    if (Date.now() - (st.edgesAt || 0) <= 10 * 60 * 1000) return st;
    st.edgesAt = Date.now();
    try {
      const tok = await communityToken();
      const jf = opts.communityFetcher || fetch;
      const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
      const email = (() => { try { return String(JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()).email || ''); } catch { return ''; } })();
      if (tok && email) {
        const eh = createHash('sha256').update(email.toLowerCase()).digest('hex');
        const r = await jf(`${dir}/edges?e=${eh}`, { headers: { authorization: `Bearer ${tok}` } });
        const eb = await r.json().catch(() => null);
        if (eb && Array.isArray(eb.edges)) st.edges = eb.edges;
        const n = await jf(`${dir}/rock-tie-notices`, { headers: { authorization: `Bearer ${tok}` } });
        const nb = await n.json().catch(() => null);
        if (nb && Array.isArray(nb.notices)) st.notices = nb.notices;
        syncTiesToAll();   // R9: fresh edges reach the boxes' ties.json
        wireAnchoredTies();   // T7: unwired anchors claim their bundle
      }
    } catch { /* stale edges beat a thrown route */ }
    return st;
  };
  // T5: one refresh body, two callers — the Sign in button (interactive-capable
  // signer) and app start (silent signer off the disk session). Everything the
  // Rocks tab, the Library and the maps show flows from here.
  const refreshCommunityMine = async (signer) => {
    const st = {}; server._communityMine = st;
    try {
      // SELF-HOST STRIP (2026-09-01): with the central directory and account
      // system deleted there are no edges to fetch and no reason to open a
      // sign-in window. Injected far ends (tests / future commons) still run.
      if (!opts.directoryUrl && !opts.communityFetcher) {
        st.reason = 'community membership is moving to the commons model; the central directory has been retired';
        return;
      }
      const signed = await signer({ nonce: randomBytes(12).toString('hex') });
      if (server._communityMine !== st) return;
      if (!signed.ok) { st.reason = signed.reason || 'sign-in did not complete'; return; }
      // Retained for the community-install content fetch (audit R9): the
      // directory tie-gates skill content, and re-signing-in for every
      // install would be ceremony. Aged-out tokens now re-mint silently
      // through communityToken() instead of dead-ending at 50 minutes.
      st.idToken = signed.idToken; st.tokenAt = Date.now();
      const email = (() => { try { return String(JSON.parse(Buffer.from(String(signed.idToken).split('.')[1], 'base64url').toString()).email || ''); } catch { return ''; } })();
      if (!email) { st.reason = 'sign-in did not prove an email'; return; }
      const eh = createHash('sha256').update(email.toLowerCase()).digest('hex');
      st.ownerE = eh;
      // The account this app is signed in as. The EMAIL is retained here (not
      // just its hash) because a mineral records its holder in readable form:
      // an ownership file that only a hash can explain is unauditable by the
      // person who owns the machine. It never leaves this process except to
      // the member's own minerals.
      st.account = { email: email.toLowerCase(), account_id: '' };
      try {
        const claims = JSON.parse(Buffer.from(String(signed.idToken).split('.')[1], 'base64url').toString());
        if (claims && claims.aid) st.account.account_id = String(claims.aid);
      } catch { /* a token minted before account ids shipped carries no aid */ }
      const jf = opts.communityFetcher || fetch;
      const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
      const r = await jf(`${dir}/edges?e=${eh}`, { headers: { authorization: `Bearer ${signed.idToken}` } });
      const eb = await r.json().catch(() => ({ edges: [] }));
      if (server._communityMine !== st) return;
      st.edges = Array.isArray(eb.edges) ? eb.edges : [];
      st.edgesAt = Date.now();   // starts the 10-min silent-repair clock on /rock-mine
      const n = await jf(`${dir}/rock-tie-notices`, { headers: { authorization: `Bearer ${signed.idToken}` } });
      const nb = await n.json().catch(() => ({ notices: [] }));
      if (server._communityMine !== st) return;
      st.notices = Array.isArray(nb.notices) ? nb.notices : [];
      syncTiesToAll();   // R9: a full refresh lands the ties on the boxes too
      wireAnchoredTies();   // T7: and any unwired anchor claims its bundle
      claimMinerals();   // the signed-in account records itself as holder on the minerals it can reach
    } catch (e) { st.reason = String(e.message || e); }
  };
  // Once the account is known, tell every mineral this machine can reach who
  // holds it (ownership model, 2026-08-10). The verb's own rules do the
  // judging: first claim wins, a mineral already held by someone else refuses
  // in words, and an unchanged re-claim is a no-op. Once per app run per host.
  //
  // This replaces armEnrolment, whose guard could never pass — it compared the
  // account against an email field the profile schema does not have.
  const claimMinerals = async () => {
    if (edition !== 'member') return;
    const st = server._communityMine || {};
    const acct = st.account || {};
    if (!acct.email) return;
    let targets = [];
    try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { return; }
    const done = server._mineralClaimed || (server._mineralClaimed = new Set());
    const payload = Buffer.from(JSON.stringify({
      account_id: String(acct.account_id || ''), email: String(acct.email || ''),
    }), 'utf8').toString('base64');
    for (const t of targets) {
      if (done.has(t.host)) continue;
      done.add(t.host);
      try {
        const r = await runCollect(t.host, MEMBER_VERBS['mineral-claim'].build({ content_b64: payload }));
        const m = String(r.out || '').match(/^MINERAL (\{.*\})$/m);
        if (m) { try { (server._minerals || (server._minerals = {}))[t.host] = JSON.parse(m[1]); } catch { /* shape drift */ } }
      } catch { /* next launch */ }
    }
  };
  // T7 (2026-08-10): the member side of anchor adoption. For every anchored
  // edge with a mineral on this machine: if the mineral is already wired,
  // re-relay its PUBLIC key halves (idempotent, covers a lost post); else
  // claim the staged bundle from the directory ONCE, run the anchor-wire verb
  // (keys minted on the mineral, private halves never leave), and relay the
  // public halves up. Fires off the same cadence as the edges themselves;
  // a per-(org,host) flag stops re-work once the relay has landed.
  const wireAnchoredTies = async () => {
    if (edition !== 'member') return;
    // SELF-HOST STRIP (2026-09-01): the wire bundles this claimed were staged
    // at the central directory, which is deleted. Nothing to claim, nowhere to
    // relay; injected far ends (tests) still exercise the machinery.
    if (!opts.directoryUrl && !opts.communityFetcher) return;
    const st = server._communityMine || {};
    if (!Array.isArray(st.edges)) return;
    let targets = [];
    try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { return; }
    const done = server._anchorWired || (server._anchorWired = new Set());
    const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
    const jf = opts.communityFetcher || fetch;
    const pubsOf = (out) => {
      const m = String(out || '').match(/^PUBKEYS (\{.*\})$/m);
      try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    };
    for (const x of st.edges) {
      if (x.rel !== 'anchored' || String(x.status || 'active') !== 'active') continue;
      const slug = String(x.slug || '');
      // THE NAME BEATS THE ADDRESS, and it beats it ACROSS THE WHOLE LIST
      // (2026-08-17, finding 152's last sibling). This was one find() ORing the
      // two arms, so the FIRST host whose label prefixed the edge's box won
      // before any later host was tried for an exact name. That matters because
      // a member's second pebble inherits the first's `box` onto its edge:
      // worker.js says so in edgeNamedBy, "the slug-scoped edge write copies
      // `box` from the slug-less base row". With that state the second edge
      // selected the FIRST mineral, and its bundle, channel repos and deploy
      // keys were carried to the wrong metal. Same rule the directory settled
      // on for the same reason: slug is the stronger claim and takes strict
      // precedence, the box label is consulted only when no name matched.
      const t = targets.find((tt) => tt.host.replace(/-box$/, '') === slug)
        || targets.find((tt) => String(x.box || '').indexOf(tt.host.replace(/-box$/, '')) === 0);
      if (!t) continue;
      const flag = `${x.org}:${t.host}`;
      if (done.has(flag)) continue;
      try {
        let pubs = pubsOf((await runCollect(t.host, MEMBER_VERBS['anchor-pubkeys'].build({ org: x.org }))).out);
        if (!pubs) {
          const tok = await communityToken();
          if (!tok) return;
          // SAY WHICH MINERAL IS CLAIMING (2026-08-17, finding 152's last
          // sibling). This body was { org } and nothing else. The app
          // authenticates as the MEMBER, so the worker's affCaller() hands the
          // route an email hash and no box, and an email hash names a PERSON:
          // with two bundles staged for one person the directory had no name to
          // select on at all. Since a5fa22e it refuses that rather than guessing
          // (409, "name yours with slug"), and this caller could never answer,
          // so BOTH pebbles stayed unwired for good. Nothing showed it either,
          // because the `continue` below reads a 409 exactly like "the rock has
          // not adopted yet".
          //
          // Both names go, because the worker reads both and they fail
          // differently. `slug` is the edge's own, which edges-reflect keeps
          // equal to the rock's REGISTRY seat, so it is the name the staged
          // bundle is filed under; it is matched exactly, and a miss is a 404 we
          // retry on the next refresh. `box_host` is the softer fallback the
          // worker uses when no slug came, which is what carries a legacy
          // slug-less edge. Sent as the same t.host the /anchor-pubkeys relay
          // below already sends, so the two halves of one wire name one mineral
          // the same way.
          const claim = (named) => jf(`${dir}/anchor-wire-claim`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
            body: JSON.stringify({ org: x.org, box_host: t.host, ...named }),
          });
          let r = await claim(slug ? { slug } : {});
          // A NAMED MISS IS NOT THE SAME AS NOTHING STAGED, and naming must not
          // be able to make this caller worse than it was. An explicit slug is
          // matched EXACTLY by the worker, and the two names can legitimately
          // disagree for a while: the rock renames the REGISTRY seat on a slug
          // collision (-2..-9) and stages the bundle under the renamed one,
          // while this edge still carries the asked name until the rock's
          // edges-reflect lands it. Finding 123 is the reminder that reflect is
          // not guaranteed to be running. So a 404 falls back to the unnamed
          // request, which is exactly what this code sent before today: it can
          // only succeed when ONE bundle is staged, which the directory itself
          // rules unambiguous, and it still gets the 409 when there are several.
          // No guess is added; the retry cannot take another mineral's bundle.
          if (r.status === 404 && slug) r = await claim({});
          if (!r.ok) continue;   // nothing staged yet: the rock adopts on its own clock
          const bundle = await r.json();
          const b64 = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
          const wired = await runCollect(t.host, MEMBER_VERBS['anchor-wire'].build({ content_b64: b64 }));
          pubs = pubsOf(wired.out);
          if (!pubs) continue;   // refused in words on the mineral; the rock re-stages in an hour
        }
        const tok2 = await communityToken();
        if (!tok2) return;
        // AND THE TWIN, five lines down (2026-08-17). box_host was the only
        // name here, and the worker reduces it to a LABEL, so it lands on the
        // edge's slug arm and then its box arm. Both arms refuse when ambiguous,
        // and both are ambiguous in the state above: a rock renames the REGISTRY
        // seat on a slug collision (-2..-9) and never the mineral, edges-reflect
        // writes that renamed slug onto the edge, so the local host label stops
        // matching any slug, and the box arm is already sharing one inherited
        // host between two pebbles. The keys then post under 409 forever. The
        // slug is the one name that survives the rename, so it goes too.
        const pr = await jf(`${dir}/anchor-pubkeys`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok2}` },
          body: JSON.stringify({ org: x.org, inbox_pub: pubs.inbox_pub, heartbeat_pub: pubs.heartbeat_pub, box_host: t.host, ...(slug ? { slug } : {}) }),
        });
        if (pr.ok) done.add(flag);
      } catch { /* the next edges refresh retries */ }
    }
  };
  // transport banners can precede the CLI's JSON: parse the outermost object
  const jsonOut = (out) => {
    const a = out.indexOf('{'), b = out.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('unreadable reply from the mineral');
    return JSON.parse(out.slice(a, b + 1));
  };
  const localSshBlob = (host) => {
    try { return readFileSync(join(sshDirOf(), `${host}.key.pub`), 'utf8').trim().split(/\s+/)[1] || ''; }
    catch { return ''; }
  };
  // The roster line for THIS machine's key, rebuilt from type + blob rather than
  // copied off disk: the .pub comment is free text this side never validated, and
  // roster-cli's PUBKEY_RE would reject a stray character in it. The blob is the
  // whole identity; the friendly name lives in the row's label.
  const localSshPubkey = (host) => {
    const blob = localSshBlob(host);
    return blob ? `ssh-ed25519 ${blob}` : '';
  };
  // Seeded from the machine's own name (2026-08-12). "this-computer" as a slug
  // was the same lie as "This computer" as a label: it collided by design, so
  // the numbering below was load-bearing rather than a rare fallback. Same
  // derivation shape enrol-sync.mjs uses for the staged-request path, so a
  // machine gets the same slug whichever way it enrolled.
  const freeDeviceSlug = (rows, base) => {
    const taken = new Set((rows || []).map((d) => d.slug));
    const stem = String(base || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 24) || 'this-computer';
    if (!taken.has(stem)) return stem;
    for (let n = 2; n <= 99; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
    return '';
  };

  // Put THIS machine on the roster when it is missing from it (2026-08-03).
  //
  // Boxes provisioned before the cloud-init roster seed (6ce5370) carry the
  // member's key ONLY in the host's /home/member/.ssh/authorized_keys, which
  // sshd reads via AuthorizedKeysFile. The container cannot see that file, so
  // the roster is empty, Devices shows nothing, Revoke cannot revoke the one
  // key that works, and the cold tier is unreachable. `roster-cli adopt` cannot
  // rescue it either: it reads the DERIVED key file, which on those boxes is
  // empty. This is the only place that can close the gap, because the app is
  // the one party that holds the key material AND can reach the box.
  //
  // Not an escalation, and deliberately not two-party: reaching this code path
  // at all means sshd already authenticated this key as the member, so the
  // device has full access to the box before the row exists. Enrolling makes
  // that access VISIBLE and revocable. It cannot mint access, because a key
  // sshd refuses never gets a command run in the first place (devices-list
  // fails first, and we return before writing anything).
  async function deviceSelfEnrol(host, rows) {
    const pubkey = localSshPubkey(host);
    if (!pubkey) return { ok: false, reason: 'this computer has no ssh identity for that mineral yet: connect it first' };
    const blob = localSshBlob(host);
    const mine = (rows || []).find((d) => d.status === 'active' && String(d.pubkey || '').split(/\s+/)[1] === blob);
    if (mine) return { ok: true, enrolled: false, slug: mine.slug, rows };
    const name = machineName();
    const slug = freeDeviceSlug(rows, name);
    if (!slug) return { ok: false, reason: `this mineral already lists 99 computers called "${name}": rename some in Devices, then try again` };
    const add = await runCollect(host, verbs['devices-add'].build({ slug, label: name, pubkey }));
    if (add.code !== 0) return { ok: false, reason: `could not enrol this computer: ${add.out.slice(0, 200)}` };
    const relist = await runCollect(host, verbs['devices-list'].build());
    if (relist.code !== 0) return { ok: false, reason: `could not read the device roster: ${relist.out.slice(0, 200)}` };
    let fresh;
    try { fresh = jsonOut(relist.out).devices || []; } catch { return { ok: false, reason: 'could not read the device roster' }; }
    return { ok: true, enrolled: true, slug, rows: fresh };
  }

  // ---- the real world, for the topology page's read-only mode --------------
  // The topology page ships four INVENTED example worlds (Acme CoLab, hosting
  // mix, enterprise, fresh rock). They teach the model well, but a member asking
  // to see THEIR network was landing in Acme CoLab. This composes the facts
  // the box already reports into the same shape the page's node model wants, so
  // the very same renderer can draw a real network instead of a story.
  //
  // Facts only, and only facts the box states about itself. The one rule that
  // matters: ownership.json carries managed_by:"org" as a DEFAULT even on a
  // standalone box in no rock (true of every self-serve pebble), so the
  // ROCK NAME decides whether an org exists here, never managed_by.
  // Inventing an org from a default would put a relationship on screen that the
  // member does not have.
  function worldFacts(state, devices, support) {
    const own = state.ownership || {};
    const orgName = String((state.org || {}).name || '').trim();
    const lineage = state.lineage || null;
    // R9 (2026-08-09): ALL rock ties draw, the anchor emphasised. ties.json is
    // what the app wrote down from the directory; org-contact.json (the
    // stamp-time seed) and the ownership anchor flag cover boxes the write has
    // not reached yet, so an anchored box never draws wireless again.
    const orgs = [];
    const seen = new Set();
    (Array.isArray(state.ties) ? state.ties : []).forEach((t) => {
      const key = String((t || {}).org || '');
      if (!key || seen.has(key)) return;
      // A platform lane is not a rock (PLATFORM_LANES). syncTiesToBox no longer
      // writes one, but a ties.json written before 2026-08-17 may still carry
      // it, and E2 forbids clearing the file to fix that — so the reader holds
      // the rule too, which is what keeps an already-poisoned box honest.
      if (PLATFORM_LANES.has(key.toLowerCase())) return;
      seen.add(key);
      orgs.push({ label: String(t.org_display || '').trim() || key,
        tie: t.tie === 'anchored' ? 'anchored' : 'joined', status: String(t.status || 'active') });
    });
    if (!orgs.some((o) => o.tie === 'anchored') && (orgName || state.anchored)) {
      orgs.unshift({ label: orgName || 'Your rock', tie: 'anchored', status: 'active' });
    }
    const anchorOrg = orgs.find((o) => o.tie === 'anchored') || null;
    return {
      // every tie, anchor first; the legacy single `org` stays one release so
      // an old client still draws its one node
      orgs,
      box: {
        label: String(state.name || '').trim() || 'Your mineral',
        tier: own.tier === 'rock' ? 'rock' : 'pebble',
        // R22 (iteration 2): no anchored rock means the Mountain anchors this
        // mineral; the map draws it. crads-ai is stripped above, so the hint
        // is exactly "no rock remains".
        mountain: !anchorOrg,
        ownedByOrg: own.owner !== 'member',
        runs: own.machinery_by === 'self' ? 'self' : own.machinery_by === 'owner' ? 'owner' : 'crads-ai',
        origin: lineage && lineage.origin === 'stamped' ? 'stamped' : 'self',
        framework: (lineage && lineage.framework_imprint) || '',
        grafts: ((lineage && lineage.reframes) || []).map((r) => ({
          from: String(r.from || ''), what: String(r.framework || ''),
          state: r.outcome === 'accepted' ? 'accepted' : 'declined',
        })),
      },
      org: anchorOrg ? { label: anchorOrg.label } : (orgName ? { label: orgName } : null),
      // The map's own law is "exactly what can open this mineral right now", so a
      // sentinel row that can open nothing has no place on it. `usable !== false`
      // rather than `=== true`: a box on an engine older than that flag sends
      // none, and its real devices must still be drawn.
      devices: (devices || []).filter((d) => d.status === 'active' && d.usable !== false)
        // slug rides along so the native map can key its chips to roster rows
        .map((d) => ({ slug: d.slug, label: d.label || d.slug, last_seen: d.last_seen || '' })),
      support: support && support.active
        ? { active: true, expires_at: String(support.active.expires_at || '') }
        : { active: false },
    };
  }

  async function topologyWorld(host) {
    // ONE SSH round-trip for the whole map (2026-08-09 lag audit): the three
    // probes ride the batched topology-state verb, marker-split here.
    const r = await runCollect(host, verbs['topology-state'].build());
    if (r.code !== 0) return { ok: false, reason: `could not read your box: ${r.out.slice(0, 200)}` };
    const consolePart = r.out.split('__DEVICES__')[0] || '';
    const line = consolePart.split('\n').find((l) => l.startsWith('CONSOLE_STATE '));
    if (!line) return { ok: false, reason: 'your mineral replied without a state line' };
    let state;
    try { state = JSON.parse(line.slice('CONSOLE_STATE '.length)); }
    catch { return { ok: false, reason: 'your mineral replied with an unreadable state line' }; }
    // Both are additive detail, never the reason the map fails: a roster or a
    // support probe that will not answer should cost you those nodes, not the
    // whole picture of who owns and runs your box.
    let devices = [];
    try { devices = jsonOut((r.out.split('__DEVICES__')[1] || '').split('__SUPPORT__')[0]).devices || []; } catch { /* drawn without them */ }
    let support = null;
    try { support = jsonOut(r.out.split('__SUPPORT__')[1] || ''); } catch { /* drawn without it */ }
    return { ok: true, ...worldFacts(state, devices, support) };
  }

  // The rock's world (P3, ruling 2026-08-09 option 2): the same map, with the
  // fleet drawn BELOW the rock. Captions stay truthful pre-ruling-3: an
  // anchored pebble is "anchored here · hosted by this rock" (registry fact),
  // never "can open" — the rock has no key into member boxes and enforcement
  // still runs on the member's own machinery. Joined affiliates draw dashed:
  // their box, their bill, directory state only. Every probe is additive: a
  // leg that will not answer costs its nodes, never the map.
  async function orgTopologyWorld(host) {
    // Same batching law as topologyWorld: four probes, one exec (2026-08-09).
    const r = await runCollect(host, verbs['org-topology-state'].build());
    if (r.code !== 0) return { ok: false, reason: `could not read your box: ${r.out.slice(0, 200)}` };
    const out = String(r.out);
    let devices = [];
    try { devices = jsonOut((out.split('__DEVICES__')[1] || '').split('__SUPPORT__')[0]).devices || []; } catch { /* drawn without them */ }
    let support = null;
    try { support = jsonOut((out.split('__SUPPORT__')[1] || '').split('__STALL__')[0]); } catch { /* drawn without it */ }
    let index = [];
    let fleetUnreadable = false;
    const hbs = {};
    const stallPart = (out.split('__STALL__')[1] || '').split('__ROCKSTATE__')[0];
    // A registry probe that never reached its __INDEX__ marker is "unreadable",
    // never "empty" (house rule) — same semantics the per-verb exit code carried.
    if (stallPart.indexOf('__INDEX__') < 0) fleetUnreadable = true;
    else {
      const idxBlob = (stallPart.split('__INDEX__')[1] || '').split('__HEARTBEATS__')[0];
      try { index = JSON.parse((idxBlob.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { /* empty fleet */ }
      const parts = (stallPart.split('__HEARTBEATS__')[1] || '').split(/^=== (.+)$/m);
      for (let i = 1; i < parts.length; i += 2) { try { hbs[parts[i].trim()] = JSON.parse(parts[i + 1]); } catch { /* no presence */ } }
    }
    let ties = [];
    {
      const rsPart = out.split('__ROCKSTATE__')[1] || '';
      const line = rsPart.split('\n').find((l) => l.startsWith('ROCK_STATE '));
      if (line) { try { ties = JSON.parse(line.slice('ROCK_STATE '.length)).ties || []; } catch { /* none */ } }
    }
    const orgSlug = host.replace(/-rock$/, '');
    const fleet = (Array.isArray(index) ? index : []).filter((m) => m && m.slug && m.status !== 'left')
      .map((m) => ({ slug: m.slug, label: m.display_name || m.slug, tie: 'anchored', status: m.status || 'active',
        last_seen: (hbs[m.slug] || {}).generated_at || '' }));
    const seen = new Set(fleet.map((f) => f.slug));
    // E4 (2026-08-10 tie audit): EVERY tie without a registry seat draws — a
    // joined member as before, and an anchored one as "wiring" (the T6/T7
    // adoption machinery builds its seat; until then hiding it was the bug
    // Sam hit: an anchored pebble invisible on its own rock's map).
    ties.filter((t) => t && (t.tie === 'joined' || t.tie === 'anchored')).forEach((t) => {
      const slug = t.slug || String(t.e || '').slice(0, 8);
      if (seen.has(slug)) return;
      fleet.push({ slug, label: slug, tie: t.tie, status: t.status || 'active', last_seen: '',
        ...(t.tie === 'anchored' ? { wiring: true } : {}) });
    });
    // The rock's OWN memberships draw on its map (finding 201, Sam 2026-08-17:
    // "Institute of Shenanigans is joined to QA Run Two Gmail, but it's not
    // showing in the network tab"). The world ended at Crads AI above and the
    // fleet below; a rock this rock had JOINED lived only on the Organisations
    // page. Same narrowing as /rock-mine's org face: the rock's own joined
    // rows, keyed to this host's slug — a rock can never be anchored, and a
    // platform lane is not a rock (PLATFORM_LANES).
    // Including the same self-exclusion /rock-mine's org face carries (finding
    // 202): the rock's own admin membership of its own org is an edge of
    // exactly this shape, and without the org test it draws the rock as a
    // community it has joined, hanging off itself on its own map.
    const joinedRocks = ((await ensureEdgesFresh()).edges || [])
      .filter((x) => x && x.rel === 'joined' && String(x.slug || '') === orgSlug
        && String(x.org || '') !== orgSlug
        && !PLATFORM_LANES.has(String(x.org || '').toLowerCase()))
      .map((x) => ({ label: String(x.org_display || '').trim() || String(x.org || ''),
        tie: 'joined', status: String(x.status || 'active') }));
    return {
      ok: true, rock: true,
      box: { label: orgSlug, tier: 'rock', ownedByOrg: false, runs: 'crads-ai', mountain: true },
      org: { label: 'Crads AI', anchor: true },
      // anchor first, then memberships: the same orgs shape worldFacts sends,
      // so netModel draws joined rocks above the rock exactly as it does above
      // a pebble (the legacy single `org` above stays for an old client)
      orgs: [{ label: 'Crads AI', tie: 'anchored', status: 'active' }, ...joinedRocks],
      devices: (devices || []).filter((d) => d.status === 'active' && d.usable !== false)
        .map((d) => ({ slug: d.slug, label: d.label || d.slug, last_seen: d.last_seen || '' })),
      support: support && support.active
        ? { active: true, expires_at: String(support.active.expires_at || '') }
        : { active: false },
      fleet,
      // the shared counting oracle's read of the same data the fleet was
      // built from, so a server-side consumer never re-derives the arithmetic
      counts: tieCounts(ties, Array.isArray(index) ? index : []),
      // honesty flag: a failed registry probe is "unreadable", never "empty"
      fleet_unreadable: fleetUnreadable,
    };
  }

  // The Devices page's own entry point to the above, so the list a member reads
  // is the list that can actually open the box.
  async function devicesSelfHeal(host) {
    const list = await runCollect(host, verbs['devices-list'].build());
    if (list.code !== 0) return { status: 200, body: { ok: false, reason: `could not read the device roster: ${list.out.slice(0, 200)}` } };
    let rows;
    try { rows = jsonOut(list.out).devices || []; } catch { return { status: 200, body: { ok: false, reason: 'could not read the device roster' } }; }
    const r = await deviceSelfEnrol(host, rows);
    return { status: 200, body: r.ok ? { ok: true, enrolled: r.enrolled, slug: r.slug } : { ok: false, reason: r.reason } };
  }
  const rosterTargets = (rows) => (rows || [])
    // roster devices only. Support grants are never roster rows (roster-cli
    // lists them separately), and the kind guard keeps that true even if a
    // future roster grows one: only member devices may be sealing targets.
    .filter((d) => d.status === 'active' && d.vaultkey && (d.kind || 'member') === 'member')
    .map((d) => ({ fingerprint: d.fingerprint, vaultkey: d.vaultkey }));

  // publish this device's vault public key onto its own roster row (matched by
  // ssh key material, which sshd already authenticated). Idempotent self-heal:
  // covers both fresh connects and devices enrolled before the vault existed.
  async function vaultSync(host) {
    const vk = ensureVaultKeypair(host, sshDirOf());
    const blob = localSshBlob(host);
    if (!blob) return { ok: false, reason: 'this computer has no ssh identity for that mineral yet: connect it first' };
    const list = await runCollect(host, verbs['devices-list'].build());
    if (list.code !== 0) return { ok: false, reason: `could not read the device roster: ${list.out.slice(0, 200)}` };
    let rows;
    try { rows = jsonOut(list.out).devices || []; } catch { return { ok: false, reason: 'could not read the device roster' }; }
    let mine = rows.find((d) => d.status === 'active' && String(d.pubkey || '').split(/\s+/)[1] === blob);
    if (!mine) {
      // Legacy box: authenticated by the host key file, absent from the roster.
      // Enrol before giving up, so the cold tier is not permanently unreachable
      // on every box provisioned before the seed landed. The old failure text
      // pointed at a Devices control that does not exist, which made this a
      // dead end rather than an error.
      const heal = await deviceSelfEnrol(host, rows);
      if (!heal.ok) return { ok: false, reason: heal.reason };
      rows = heal.rows;
      mine = rows.find((d) => d.status === 'active' && String(d.pubkey || '').split(/\s+/)[1] === blob);
      if (!mine) return { ok: false, reason: 'this computer could not be added to the mineral’s device roster' };
    }
    let published = false;
    if ((mine.vaultkey || '') !== vk.vaultPublicKey) {
      const put = await runCollect(host, verbs['devices-set-vaultkey'].build({ slug: mine.slug, vaultkey: vk.vaultPublicKey }));
      if (put.code !== 0) return { ok: false, reason: `could not publish this computer’s vault key: ${put.out.slice(0, 200)}` };
      published = true;
      mine.vaultkey = vk.vaultPublicKey;
    }
    return { ok: true, slug: mine.slug, published, devices: rows };
  }

  async function vaultSeal(host, form) {
    const value = String(form.value ?? '');
    if (!value.trim()) return { status: 400, body: { ok: false, reason: 'give it a value' } };
    if (value.length > 100000) return { status: 400, body: { ok: false, reason: 'that value is too large (max ~100 KB)' } };
    // sync first, so the device doing the sealing can always reopen the result
    const sync = await vaultSync(host);
    if (!sync.ok) return { status: 400, body: sync };
    const targets = rosterTargets(sync.devices);
    if (!targets.length) return { status: 400, body: { ok: false, reason: 'no enrolled computer has a vault key yet: open the app on each computer once so it can mint one' } };
    let spec;
    try {
      const envelope = sealEnvelope(value, targets);
      spec = verbs['secrets-put'].build({
        name: form.name, label: form.label || form.name, tier: 'cold',
        content_b64: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
      });
    } catch (e) { return { status: 400, body: { ok: false, reason: String(e.message || e) } }; }
    const put = await runCollect(host, spec);
    return { status: put.code === 0 ? 200 : 502, body: { ok: put.code === 0, output: put.out, sealedTo: targets.length } };
  }

  async function vaultOpen(host, form) {
    const name = String(form.name ?? '');
    const env = await runCollect(host, verbs['secrets-envelopes'].build());
    if (env.code !== 0) return { status: 502, body: { ok: false, reason: 'could not read from the mineral' } };
    let rows;
    try { rows = jsonOut(env.out).secrets || []; } catch { return { status: 502, body: { ok: false, reason: 'unreadable reply from the mineral' } }; }
    const s = rows.find((x) => x.name === name);
    if (!s) return { status: 404, body: { ok: false, reason: `nothing called "${name.slice(0, 64)}" is stored` } };
    if (s.tier !== 'cold' || !s.envelope) return { status: 400, body: { ok: false, reason: 'that secret is not sealed: your mineral can read it itself' } };
    const keyPath = join(sshDirOf(), `${host}.vault.key`);
    if (!existsSync(keyPath)) return { status: 400, body: { ok: false, reason: 'this computer has no vault key for that mineral, so it cannot open sealed secrets' } };
    try {
      const value = openEnvelope(s.envelope, readFileSync(keyPath, 'utf8').trim());
      return { status: 200, body: { ok: true, value } };
    } catch (e) { return { status: 400, body: { ok: false, reason: String(e.message || e) } }; }
  }

  // re-seal every cold secret this device can open to the CURRENT roster:
  // called after a device is added (so it can open them too) or revoked (so
  // its wrap is dropped). Anything this device cannot open is reported stale,
  // never silently skipped.
  async function vaultRewrap(host) {
    const sync = await vaultSync(host);
    if (!sync.ok) return { status: 400, body: sync };
    const targets = rosterTargets(sync.devices);
    if (!targets.length) return { status: 400, body: { ok: false, reason: 'no enrolled computer has a vault key: nothing to re-seal to' } };
    const env = await runCollect(host, verbs['secrets-envelopes'].build());
    if (env.code !== 0) return { status: 502, body: { ok: false, reason: 'could not read from the mineral' } };
    let rows;
    try { rows = jsonOut(env.out).secrets || []; } catch { return { status: 502, body: { ok: false, reason: 'unreadable reply from the mineral' } }; }
    const keyPath = join(sshDirOf(), `${host}.vault.key`);
    const priv = existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '';
    const resealed = [], stale = [];
    for (const s of rows.filter((x) => x.tier === 'cold' && x.envelope)) {
      if (!priv) { stale.push({ name: s.name, reason: 'no vault key on this computer' }); continue; }
      try {
        const value = openEnvelope(s.envelope, priv);
        const spec = verbs['secrets-put'].build({
          name: s.name, label: s.label || s.name, tier: 'cold',
          content_b64: Buffer.from(JSON.stringify(sealEnvelope(value, targets)), 'utf8').toString('base64'),
        });
        const put = await runCollect(host, spec);
        if (put.code === 0) resealed.push(s.name);
        else stale.push({ name: s.name, reason: 'the mineral refused the update' });
      } catch {
        stale.push({ name: s.name, reason: 'sealed before this computer was enrolled: open the app on an older computer to refresh it' });
      }
    }
    return { status: 200, body: { ok: true, resealed, stale, sealedTo: targets.length } };
  }

  async function vaultRoute(routePath, host, form, res) {
    const respond = (r) => {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    };
    const mutating = routePath === '/vault/seal' || routePath === '/vault/rewrap';
    if (mutating && busy) {
      respond({ status: 409, body: { ok: false, reason: 'another action is still running: wait for it to finish, then try again' } });
      return;
    }
    if (mutating) busy = true;
    try {
      if (routePath === '/vault/sync') {
        const r = await vaultSync(host);
        delete r.devices;   // roster rows are the devices-list verb's to serve
        respond({ status: 200, body: r });
      } else if (routePath === '/vault/seal') respond(await vaultSeal(host, form));
      else if (routePath === '/vault/open') respond(await vaultOpen(host, form));
      else if (routePath === '/vault/rewrap') respond(await vaultRewrap(host));
      else respond({ status: 404, body: { ok: false, reason: 'no such vault action' } });
    } catch (e) {
      respond({ status: e.status === 400 ? 400 : 500, body: { ok: false, reason: String(e.message || e) } });
    } finally { if (mutating) busy = false; }
  }

  // D53 terminal widget: interactive ssh -tt sessions, raw bytes both ways.
  // The browser drives xterm.js; this side is only a byte shuttle. Sessions die
  // with their SSE stream (a terminal nobody is watching has no reason to live).
  const vendorFiles = opts.vendor || {};
  const terms = new Map();
  let termSeq = 0;
  const TERM_MAX = 4;
  const termCleanup = (id) => {
    const t = terms.get(id);
    if (!t) return;
    terms.delete(id);
    try { t.pebble.kill(); } catch { /* already gone */ }
    if (t.res) { try { t.res.end(); } catch { /* closed */ } }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    // One gate for every state-changing verb on this server (2026-08-20 audit).
    // This is the widest-privilege surface in the app: /term/open lands a shell
    // in the org container, and its ids are sequential, so a blind cross-origin
    // POST pair was enough to run commands there.
    if (crossOriginBlocked(req)) return refuseCrossOrigin(res);

    // the mineral inventory, shared with door-server (ruling 8)
    if (inventory(req, res, path)) return;

    // Which mineral this computer had open last (ruling 6: launch = last-used
    // box). The DASHBOARD is the writer, not the door: this fires whenever a
    // mineral is actually opened, which covers every way in -- the start screen,
    // the picker, a crads-ai://box/ link from a ready email, and the direct
    // launch a single-mineral machine gets. The door's own localStorage record
    // stays for its anchor rail; app.mjs cannot read a browser profile, which is
    // why this file exists at all.
    // Best-effort by design: failing to record a preference must never fail the
    // request that was opening a mineral.
    if (req.method === 'POST' && path === '/last-used') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) body = body.slice(0, 2000); });
      req.on('end', () => {
        let ok = false;
        // opts.lastUsedPath is the OPT-IN, and its absence is a no-op rather
        // than a default. Only wizard/app.mjs passes it. Everything else that
        // boots this server -- the qa harnesses, panel-drive.mjs, a two-line
        // scratch driver in /tmp -- serves the same member.html, which POSTs
        // here on every boot; while this route had a default it wrote the
        // operator's own ~/.crads-ai/last-used.json and silently changed which
        // mineral their app opened next launch. Four sites over 2026-08-13/14;
        // the first three were fixed one at a time, which is how the fourth
        // happened. Same class as "tests never touch provisioning": the refusal
        // has to be structural, not left to discipline.
        try { ok = writeLastUsed(JSON.parse(body || '{}').alias, opts.lastUsedPath); } catch { ok = false; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }

    // /device-code lived here until 2026-08-11. It served the member's half of a
    // two-party approval: a 6-char code to read to whoever set the mineral up.
    // Sam retired the whole ceremony ("the user shouldn't need a code or
    // anything"), so the code is gone rather than merely hidden: a route that
    // still answers is a route a future screen re-grows.
    // T9's device leg, reachable from the dashboard's not-let-in state as well as
    // the door (Sam's ruling 2026-08-11: nobody reads a code to anybody). Same two
    // relays door-server carries, same modules, same decider: the MINERAL admits
    // the machine, this only asks. A dead end that told the member to go find a
    // human is what these replace.
    // /account/devices + /account/enrol-device (T9's device relays) retired
    // with the self-host strip, 2026-09-01: they relayed staged enrolments
    // through the central directory + crads account system, both deleted.
    // Adding a computer is a LOCAL act now — the rock panel's device-add
    // appends the key to the member door directly. Injected test modules
    // (opts.deviceEnrolModule) still get the old relay so the machinery's own
    // tests keep their subject until the account strip lands.
    if (req.method === 'GET' && path === '/account/devices') {
      if (!opts.deviceEnrolModule) {
        res.writeHead(410, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, retired: true, reason: 'the central account service has been retired; ask your rock admin to add this computer from the panel' }));
        return;
      }
      (async () => {
        try {
          const acct = opts.accountModule || await import('./crads-account.mjs');
          const mod = opts.deviceEnrolModule;
          const r = await mod.listEnrollable({ getToken: acct.getAppToken,
            ...(opts.accountFetcher ? { fetcher: opts.accountFetcher } : {}),
            ...(opts.directoryUrl ? { directoryUrl: opts.directoryUrl } : {}) });
          res.writeHead(r.ok ? 200 : 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: String((e && e.message) || e) }));
        }
      })();
      return;
    }
    if (req.method === 'POST' && path === '/account/enrol-device') {
      if (!opts.deviceEnrolModule) {
        res.writeHead(410, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, retired: true, reason: 'the central account service has been retired; ask your rock admin to add this computer from the panel' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => { (async () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        try {
          const acct = opts.accountModule || await import('./crads-account.mjs');
          const mod = opts.deviceEnrolModule;
          const r = await mod.enrolThisDevice({
            host: String(form.host || ''), deviceName: String(form.device_name || ''),
            getToken: acct.getAppToken,
            ...(opts.accountFetcher ? { fetcher: opts.accountFetcher } : {}),
            ...(opts.directoryUrl ? { directoryUrl: opts.directoryUrl } : {}),
            ...(opts.sshDir ? { sshDir: opts.sshDir } : {}),
          });
          res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: String((e && e.message) || e) }));
        }
      })(); });
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/panel.html')) {
      const wzq = typeof opts.wizardUrl === 'function' ? opts.wizardUrl() : opts.wizardUrl;
      if (url.searchParams.get('wizard') === '1' && wzq) {
        res.writeHead(302, { location: wzq }); res.end(); return;
      }
      // E7.1 REVERSED (upgraded-pebble ruling, 2026-08-09): the console-as-front-
      // face cutover (flipped ON 2026-07-28, member-exempted 2026-08-04) is over.
      // Both editions now land on THE ONE APP SHELL (member.html), which grows
      // the org sections when the server stamps edition=org below. The standalone
      // console stays served at /console as a legacy surface until its ten
      // exclusive verbs are re-homed (P3 of the 2026-08-09 rock-dashboard spec).
      // The edition stamp rides the same quoted-placeholder pattern as /topology:
      // a body without the placeholder (old bakes, tests) is a no-op, and an
      // unstamped file behaves as the white-label member face.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(String(html()).replace("'__AIOS_EDITION__'", JSON.stringify(edition === 'member' ? 'member' : 'org')));
      return;
    }

    // E6.1: the minimum console (org seat). Same process, same auth context as
    // the panel; the page is read-only except answering requests (console-answer,
    // admin-gated at the verb). Served only for the org edition: the member
    // console seat is the member app's (plan E6, remaining).
    if (req.method === 'GET' && path === '/console') {
      // The ORG console retired with P3 (2026-08-09): its ten verbs live on the
      // app's Rocks/Overview/Pebbles surfaces now, so an old bookmark lands on
      // the app rather than a dead page. The MEMBER standalone seat survives.
      if (edition !== 'member') { res.writeHead(302, { location: '/' }); res.end(); return; }
      let body = opts.consoleHtml ?? null;
      if (!body) {
        try { body = readFileSync(join(HERE, 'member-console.html')); } catch { /* not shipped */ }
      }
      if (!body) { res.writeHead(404); res.end('this build has no console page'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    // The topology sandbox: the model's reference diagram, served in every mineral's
    // app rather than hand-forked per person (the harriet-copy pattern). One file
    // for both editions; the console faces link it with ?open=/&seat= so each
    // user lands on a sensible world for their seat. Static model, presets only:
    // feeding it live registry data is the console epic (E6), not this route.
    if (req.method === 'GET' && path === '/topology') {
      let body = opts.topologyHtml ?? null;
      if (!body) {
        try { body = readFileSync(join(HERE, 'topology.html')); } catch { /* not shipped */ }
      }
      if (!body) { res.writeHead(404); res.end('this build has no topology page'); return; }
      // Stamp the serving edition into the page so its app-link layer can point
      // verbs at THIS face's real sections ("do it for real"). The placeholder
      // is quoted in the file; JSON.stringify keeps the replacement a string
      // literal. A body without the placeholder (tests, older bakes) is a no-op.
      body = body.toString().replace("'__AIOS_EDITION__'", JSON.stringify(edition === 'member' ? 'member' : 'org'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    // Verb-interview ruling 2026-08-03: a rock can birth a member their own
    // community ("rock for a member"). Rides the creator-door concierge rails:
    // this route FORCES the rock shape server-side and relays to the directory,
    // so the app cannot post arbitrary create-requests through it. Org edition
    // + Admin only. Honest-fails when the funnel is not live: the worker
    // answers a plain-words error, or 502 here when unreachable.
    // /rock-request (the New-Rock concierge) DIED 2026-08-09 (second loop):
    // rocks can't create rocks (mountain-model ladder rule). New rocks are
    // born at the sign-up door, by the person who will own them.
    if (req.method === 'GET' && path === '/wizard') {
      const wu = typeof opts.wizardUrl === 'function' ? opts.wizardUrl() : opts.wizardUrl;
      if (wu) { res.writeHead(302, { location: wu }); res.end(); }
      else { res.writeHead(404); res.end('the setup wizard is not running in this session'); }
      return;
    }

    // The counting oracle, served to the page verbatim (2026-08-17). One
    // arithmetic for "how many members": member.html loads this, this server
    // imports it, the tests run it standalone. Stripping the export keyword is
    // the whole build step, which is why the module body stays ES5-clean.
    if (req.method === 'GET' && path === '/tie-counts.js') {
      let src;
      try { src = readFileSync(join(HERE, 'tie-counts.mjs'), 'utf8').replace(/^export /gm, ''); }
      catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(src);
      return;
    }

    // D53: vendored frontend assets (xterm.js + css), embedded in the exe.
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      const name = path.slice(8);
      const safe = /^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) && !name.split('/').includes('..');
      const body = vendorFiles[name] || (safe
        ? (() => { try { return readFileSync(join(HERE, 'vendor', name)); } catch { return null; } })() : null);
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css'
        : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' });
      res.end(body);
      return;
    }

    // D53 terminal session endpoints.
    if (req.method === 'POST' && path === '/term/open') {
      // A terminal is the widest privilege this app hands out: it lands in the
      // org container, where /state/secrets/provisioning.env.local holds the
      // org's Hetzner, Cloudflare and GitHub tokens, deprovision scripts are
      // runnable, and people/<self>.yaml can be edited to self-promote to Admin.
      // Every other privileged route gates Support (/org-teardown,
      // and /run via adminOnly), so shipping the Terminal tab ungated made this
      // file's own claim that "Support never reaches destroy, policy, or secrets"
      // false: none of that is reachable through /run, all of it through a shell.
      // The DURABLE half of this gate is box-side, in enter-aios: sshd knows which
      // login authenticated, and this role does not (see the AIOS_PANEL_ROLE note).
      if (role === 'support') {
        res.writeHead(403);
        res.end('a terminal needs an Admin login (you are signed in as Support)');
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === targetKind); } catch { targets = []; }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end('host must be a configured target'); return;
        }
        if (!bridge.tty) { res.writeHead(500); res.end('this build has no terminal transport'); return; }
        if (terms.size >= TERM_MAX) { res.writeHead(429); res.end('too many open terminals; close one first'); return; }
        let pebble;
        try { pebble = bridge.tty(host, { cols: form.cols, rows: form.rows }); }
        catch (e) { res.writeHead(500); res.end(String(e.message || e)); return; }
        const id = `t${++termSeq}`;
        const t = { pebble, res: null, buf: [], buffered: 0 };
        terms.set(id, t);
        const emit = (chunk) => {
          const b64 = Buffer.from(chunk).toString('base64');
          if (t.res) { try { t.res.write(`data: ${b64}\n\n`); } catch { /* viewer gone */ } }
          else if (t.buffered < 2e6) { t.buf.push(b64); t.buffered += b64.length; }
        };
        pebble.stdout.on('data', emit);
        pebble.stderr.on('data', emit);
        pebble.on('error', (e) => { emit(Buffer.from(`\r\nERROR: could not start SSH: ${e.message || e}\r\n`)); });
        pebble.on('close', (code) => {
          if (t.res) { try { t.res.write(`event: exit\ndata: ${code ?? 1}\n\n`); } catch { /* gone */ } }
          termCleanup(id);
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
      });
      return;
    }
    if (req.method === 'GET' && path === '/term/stream') {
      const id = url.searchParams.get('id') || '';
      const t = terms.get(id);
      if (!t) { res.writeHead(404); res.end('no such terminal'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      t.res = res;
      for (const b64 of t.buf) { try { res.write(`data: ${b64}\n\n`); } catch { break; } }
      t.buf = []; t.buffered = 0;
      res.on('close', () => termCleanup(id));
      return;
    }
    if (req.method === 'POST' && path === '/term/input') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const t = terms.get(String(form.id ?? ''));
        if (!t) { res.writeHead(404); res.end('no such terminal'); return; }
        const b64 = String(form.data_b64 ?? '');
        if (!B64_RE.test(b64) || b64.length > 8e5) { res.writeHead(400); res.end('data_b64 must be base64'); return; }
        try { t.pebble.stdin.write(Buffer.from(b64, 'base64')); } catch { /* dying pebble */ }
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    if (req.method === 'POST' && path === '/term/close') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        termCleanup(String(form.id ?? ''));
        res.writeHead(200); res.end('ok');
      });
      return;
    }

    // D54: delete the WHOLE rock. The heaviest gun in the app, so the
    // server re-verifies every guardrail independently of the UI: Admin role,
    // the exact arming phrase, and a live registry read proving the rock
    // has no members left (every registry record is status: left). One button
    // never nukes members.
    // The teardown itself runs LOCALLY via the engine (opts.orgTeardown from
    // app.mjs) against the wizard's state file, with cloud tokens the admin
    // re-pastes: they are never stored, so re-supplying them is both required
    // and the final proof of infrastructure ownership. The GitHub brain repo
    // is deliberately untouched (data outlives infrastructure).
    if (req.method === 'POST' && path === '/org-teardown' && edition === 'org') {
      if (role === 'support') { res.writeHead(403); res.end('deleting a rock needs an Admin login (you are signed in as Support)'); return; }
      if (!opts.orgTeardown) { res.writeHead(501); res.end('this session cannot tear down a rock (no local engine)'); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
        if (!hostShapeOk(host) || !targets.some((t) => t.host === host)) {
          res.writeHead(400); res.end('host must be a configured rock'); return;
        }
        const org = host.replace(/-rock$/, '');
        // Hosted rocks are refused BEFORE the token dance (2026-08-09): the
        // platform owns their Hetzner/Cloudflare infrastructure, so the owner
        // never held these codes and no pasteable value can make this work.
        // Refusing here keeps the failure honest instead of letting deprovision
        // die later on a state file this computer never had.
        if (typeof opts.orgProvisioned === 'function' && !opts.orgProvisioned(org)) {
          res.writeHead(400);
          res.end(`this computer did not provision '${org}', so there is nothing here to tear down with. `
            + 'If this rock is hosted for you, its infrastructure belongs to the platform: ask for deletion '
            + 'through your rock (evict, then suspend, then delete, with a verified backup first). '
            + 'Your brain repository stays in your own GitHub account either way.');
          return;
        }
        if (String(form.confirm ?? '') !== `delete ${org} forever`) {
          res.writeHead(400); res.end(`to arm this you must type exactly: delete ${org} forever`); return;
        }
        const tokens = {};
        for (const [k, label] of [['hcloud_token', 'Hetzner'], ['cf_api_token', 'Cloudflare'], ['github_token', 'GitHub']]) {
          const v = String(form[k] ?? '').trim();
          if (!v || v.length > 300 || /[\x00-\x1f\x7f\s]/.test(v)) { res.writeHead(400); res.end(`the ${label} access code is missing or malformed; paste it exactly as issued`); return; }
          tokens[k] = v;
        }
        // OPTIONAL fourth: the org's own directory token, which retires the
        // handle so the name can be used again. Optional because an org that
        // never registered has no handle to retire, and a missing token must
        // never block a teardown; the engine says plainly when it skips.
        const orgPull = String(form.org_pull_token ?? '').trim();
        if (orgPull) {
          if (orgPull.length > 300 || /[\x00-\x1f\x7f\s]/.test(orgPull)) { res.writeHead(400); res.end('the directory token is malformed; paste it exactly as issued, or leave it blank'); return; }
          tokens.org_pull_token = orgPull;
        }
        if (busy) { res.writeHead(409); res.end('another action is still running: wait for it to finish, then try again'); return; }
        busy = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (line) => { try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { /* client gone */ } };
        let done = false;
        const finish = (code) => {
          if (done) return; done = true; busy = false;
          send(code === 0 ? '__DONE__' : `__FAIL__ exit ${code}`);
          try { res.end(); } catch { /* closed */ }
        };
        // Guardrail re-check the UI cannot skip: read the live registry off the
        // rock; any member that has not 'left' refuses the teardown. An
        // unreachable rock (already half-dead org) proceeds with a loud
        // warning: the teardown is driven from local state, not the box.
        send('▸ verifying the rock has no members left…');
        const lines = [];
        let probe;
        try {
          probe = bridge.stream(host, VERBS['member-list'].build().command, {
            onStdout: (l) => lines.push(l), onStderr: (l) => lines.push(l),
          });
        } catch (e) { send(`WARN: could not re-check the registry (${e.message || e}); proceeding from local state`); probe = null; }
        const runTeardown = () => {
          send('▸ tearing down the rock…');
          Promise.resolve()
            .then(() => opts.orgTeardown({ org, hcloudToken: tokens.hcloud_token, cfToken: tokens.cf_api_token, githubToken: tokens.github_token, ...(tokens.org_pull_token ? { orgPullToken: tokens.org_pull_token } : {}) }, send))
            .then(() => finish(0))
            .catch((e) => { send(`ERROR: ${e && e.message ? e.message : e}`); finish(1); });
        };
        if (!probe) { runTeardown(); return; }
        probe.on('error', () => { send('WARN: rock unreachable; proceeding from local state'); runTeardown(); });
        probe.on('close', (code) => {
          if (code !== 0) { send('WARN: rock unreachable or registry unreadable; proceeding from local state'); runTeardown(); return; }
          // Count member RECORDS, not just cleanly-parseable status lines.
          // member-list emits one "=== <path>" marker per member yaml, so split
          // on the markers and inspect each record. A member counts as still in
          // the rock unless its top-level status is explicitly 'left':
          // a missing or malformed status blocks too. "A rock can only
          // be deleted once it has no members" must fail SAFE, an unreadable
          // member never waves the teardown through.
          const records = lines.join('\n').split(/^=== .*$/m).slice(1);
          const remaining = records.filter((r) => !/^status:\s*"?left"?\s*$/m.test(r));
          if (remaining.length) {
            send(`REFUSED: this rock still has ${remaining.length} member${remaining.length === 1 ? '' : 's'}. A rock can only be deleted once every member has left.`);
            send('Remove or tear down each remaining member first (Danger tab, one at a time) so no one loses their assistant by accident.');
            finish(1);
            return;
          }
          send('  the rock has no members; proceeding');
          runTeardown();
        });
      });
      return;
    }

    // ---- demote (promote ruling § 4, 2026-08-04): the org face of a PROMOTED box
    // retires IN PLACE; the personal seat stays and the box keeps its address and
    // alias. Inherits the teardown guard's member check but FAIL-CLOSED: demote
    // flips a LIVE box, so an unreadable registry REFUSES (teardown may proceed
    // from local state because its org can already be half-dead; a demote has no
    // such excuse). Only probe-promoted -box hosts land here: a classic -rock
    // rock is deleted via /org-teardown, not retired.
    if (req.method === 'POST' && path === '/demote' && edition === 'org') {
      if (role === 'support') { res.writeHead(403); res.end('retiring a rock needs an Admin login (you are signed in as Support)'); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === 'rock'); } catch { targets = []; }
        const t = targets.find((x) => x.host === host);
        if (!t || !t.promoted) { res.writeHead(400); res.end('demote applies only to a rock started in place on a personal mineral; a full rock is deleted via teardown'); return; }
        // Case-folded to match the client gate: the panel renders the required
        // phrase uppercased, so both ends accept the phrase the user actually sees.
        if (String(form.confirm ?? '').trim().toLowerCase() !== 'retire this rock') {
          res.writeHead(400); res.end('to arm this you must type exactly: retire this rock'); return;
        }
        if (busy) { res.writeHead(409); res.end('another action is still running: wait for it to finish, then try again'); return; }
        busy = true;
        let settled = false;
        const fail = (code, msg) => { if (settled) return; settled = true; busy = false; res.writeHead(code); res.end(msg); };
        // Guard (ruling § 4): any member not explicitly 'left' refuses, and so does
        // an unreadable registry — no proof of empty, no demote. Same fail-safe
        // record parse as teardown: a malformed member blocks too.
        const lines = [];
        let probe;
        try {
          probe = bridge.stream(host, VERBS['member-list'].build().command, {
            onStdout: (l) => lines.push(l), onStderr: (l) => lines.push(l),
          });
        } catch (e) { fail(502, `could not read the member registry (${e.message || e}); demote refuses without proof the rock is empty`); return; }
        probe.on('error', (e) => fail(502, `could not read the member registry (${e.message || e}); demote refuses without proof the rock is empty`));
        probe.on('close', (code) => {
          if (settled) return;
          if (code !== 0) { fail(502, 'could not read the member registry; demote refuses without proof the rock is empty'); return; }
          const records = lines.join('\n').split(/^=== .*$/m).slice(1);
          const remaining = records.filter((r) => !/^status:\s*"?left"?\s*$/m.test(r));
          if (remaining.length) {
            fail(409, `this rock still has ${remaining.length} member${remaining.length === 1 ? '' : 's'}; a rock can only retire once every member has left`); return;
          }
          const out = [];
          let flip;
          try {
            flip = bridge.stream(host, DEMOTE_RUN, { onStdout: (l) => out.push(l), onStderr: (l) => out.push(l) });
          } catch (e) { fail(500, `demote failed: ${e.message || e}`); return; }
          flip.on('error', (e) => fail(500, `demote failed: ${e.message || e}`));
          flip.on('close', (c2) => {
            if (settled) return;
            if (c2 !== 0) { fail(500, `demote failed on the mineral (exit ${c2}): ${out.join(' ').slice(0, 200)}`); return; }
            settled = true; busy = false;
            // the local face registry drops the org face; the box's own record is
            // already the truth the next probe would read
            try { if (typeof opts.onDemoted === 'function') opts.onDemoted(host); } catch { /* best-effort */ }
            // The BOX decides what actually happened to the directory handle:
            // demote.mjs calls /unregister and says so, while the fallback tier
            // flip cannot and leaves the name claimed. /register is
            // first-write-wins, so a claimed handle refuses any rebuild under
            // that name forever. Carry the box's own answer rather than
            // reporting a flat success over the top of it.
            const said = out.join(' ');
            const handleRetired = /retired the handle/i.test(said);
            const msg = 'the rock is retired; this mineral is a pebble again and keeps its personal seat'
              + (handleRetired
                ? ', and its directory handle was retired so the name can be used again'
                : '. Its directory handle is STILL REGISTERED: the name stays claimed and a rebuild under it would be refused');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, host, handle_retired: handleRetired, msg }));
          });
        });
      });
      return;
    }

    // ---- promotion, member side (Mountain model + promote ruling, 2026-08-04) --------------
    // Member edition only, and the panel never holds a platform credential (brokered
    // ruling): /promote/start verifies the PRE-COPY on the box itself — a real push to
    // the member's OWN backup remote, no remote means no promotion — then signs the
    // caller in for an ID token and parks the request on the directory queue for the
    // cockpit to fulfil operator-side. /promote/status proxies the watchable progress
    // record. /promote/flip re-checks the worker's `done` SERVER-SIDE (the UI cannot
    // assert it), then flips the box's own ownership record to tier rock, owner org —
    // after which the face probe surfaces the org face beside the personal seat.
    if (edition === 'member' && req.method === 'POST' && path === '/promote/start') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => t.kind === 'member'); } catch { targets = []; }
        if (!MEMBER_HOST_RE.test(host) || !targets.some((t) => t.host === host)) {
          res.writeHead(400); res.end('host must be a configured <slug>-box target'); return;
        }
        const handle = String(form.org_handle ?? '').trim();
        if (!ORG_RE.test(handle)) { res.writeHead(400); res.end('bad org handle'); return; }
        if (String(form.consent ?? '') !== PROMOTE_CONSENT) {
          res.writeHead(400); res.end(`promotion needs the consent sentence, exactly: "${PROMOTE_CONSENT}"`); return;
        }
        const slug = host.replace(/-box$/, '');
        // AN ANCHORED PEBBLE PROMOTES AND UNANCHORS AS IT GOES (Sam's ruling
        // 2026-08-10, replacing the 2026-08-04 refusal). A rock cannot be
        // anchored to a rock, so the anchor is dropped as PART of the upgrade
        // rather than being made the member's homework: the tie survives as a
        // community join, which is a shape the model already has (a rock may
        // join another rock, P3 2026-08-09), and the money follows the registry
        // on its own (billing-sync derives a rock's seat count from the rows
        // anchored to it, so the old rock stops paying for this seat while
        // swapToRockTier starts the rock tier here).
        //
        // ORG-OWNED IS STILL A REFUSAL, and the model forces it rather than
        // caution: an owning org must hold an edge to the box it owns
        // (validateRow names an owner without one an "absentee owner") and
        // owner-rock implies anchor-rock, so unanchoring an owned mineral would
        // write exactly the row the rule calls illegal. The ownership has to
        // move first, and that is the rock's act.
        //
        // Fail-closed throughout: an unreadable record refuses; a missing anchor
        // field on an old solo box normalizes to the Mountain (the uniform-rule
        // default) and passes with nothing to unanchor.
        const ownLines = [];
        let ownProbe;
        // The rock this mineral is anchored to, if any, read off the box's own
        // record and carried to the directory so the Mountain can demote the
        // edge to a community join at fulfilment. It is never taken from the
        // page: the box states its own anchor, or there is no promotion.
        let unanchorFrom = '';
        try {
          ownProbe = bridge.stream(host, 'cat /state/ownership.json 2>/dev/null', { onStdout: (l) => ownLines.push(l), onStderr: (l) => ownLines.push(l) });
        } catch (e) { res.writeHead(502); res.end(`could not read the mineral's ownership record (${e.message || e}); promotion refuses without it`); return; }
        let ownSettled = false;
        const ownFail = (code, msg) => { if (ownSettled) return; ownSettled = true; res.writeHead(code); res.end(msg); };
        ownProbe.on('error', (e) => ownFail(502, `could not read the mineral's ownership record (${e.message || e}); promotion refuses without it`));
        ownProbe.on('close', () => {
          if (ownSettled) return;
          const own = parseOwnership(ownLines.join('\n'));
          if (!own) { ownFail(502, "could not read the mineral's ownership record; promotion refuses without it"); return; }
          if (own.tier === 'rock') { ownFail(409, 'this mineral is already a rock'); return; }
          const anchor = String(own.anchor || 'crads-ai');
          const ownedBy = own.owner && own.owner !== 'member' ? String(own.owner_slug || anchor || own.owner) : '';
          if (ownedBy) {
            ownFail(409, `"${ownedBy}" owns this mineral, so it cannot become a rock: a rock owns itself, and an owned mineral must stay anchored to its owner. Ask them to hand it over to you first (their console, Hand over), then promote. Nothing has been changed here.`);
            return;
          }
          unanchorFrom = anchor === 'crads-ai' ? '' : anchor;
          ownSettled = true;
          runPrecopy();
        });
        const runPrecopy = () => {
        const lines = [];
        let pre;
        try {
          pre = bridge.stream(host, PRECOPY_CMD, { onStdout: (l) => lines.push(l), onStderr: (l) => lines.push(l) });
        } catch (e) { res.writeHead(502); res.end(`could not reach the mineral (${e.message || e})`); return; }
        let settled = false;
        const fail = (code, msg) => { if (settled) return; settled = true; res.writeHead(code); res.end(msg); };
        pre.on('error', (e) => fail(502, `could not reach the mineral (${e.message || e})`));
        pre.on('close', (code) => {
          if (settled) return;
          const out = lines.join('\n');
          const okLine = out.split('\n').find((l) => l.startsWith('PRECOPY-OK '));
          if (code !== 0 || !okLine) {
            fail(409, /PRECOPY-NONE/.test(out)
              ? 'no verified pre-promotion copy: connect your own GitHub backup first (Connect my GitHub), then try again'
              : `pre-promotion copy failed (${out.slice(-160) || 'no output'}); promotion refused without it`);
            return;
          }
          const repo = okLine.slice('PRECOPY-OK '.length).trim().slice(0, 200);
          Promise.resolve()
            .then(async () => {
              const idToken = typeof opts.promoteIdToken === 'function' ? await opts.promoteIdToken() : '';
              if (!idToken) { fail(501, 'this session cannot sign you in for promotion; open the app and try again'); return; }
              const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
              const r = await fetch(`${dir}/promote-request`, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' },
                body: JSON.stringify({
                  org_handle: handle, org_display: String(form.org_display || handle).slice(0, 80),
                  slug, consent: PROMOTE_CONSENT, precopy: { repo, verified: true },
                  ...(unanchorFrom ? { unanchor_from: unanchorFrom } : {}),
                }),
              });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) { fail(r.status, String(j.error || 'the directory refused the request')); return; }
              // Record the in-flight promotion ON THE BOX so the seat can pick
              // the watch back up later (see promotePendingWriteCmd). Awaited so
              // a returning member normally finds it, but never fatal: the
              // request is already parked at the directory by this point, and
              // failing the promotion over a marker would be the worse harm.
              // The page's own watcher covers this session regardless.
              if (/^[a-f0-9]{16,64}$/.test(String(j.id || ''))) {
                await new Promise((resolve) => {
                  let w;
                  try { w = bridge.stream(host, promotePendingWriteCmd(String(j.id), handle)); }
                  catch { resolve(); return; }
                  w.on('error', () => resolve());
                  w.on('close', () => resolve());
                });
              }
              settled = true;
              res.writeHead(200, { 'content-type': 'application/json' });
              // `resume` means the directory recognised this as the caller's own
              // half-finished promotion: already registered, already fulfilled,
              // only the box-side flip missing. The card must not call that
              // "registering" — nothing is being registered a second time.
              res.end(JSON.stringify({ ok: true, id: j.id, already: !!j.already, resume: !!j.resume, precopy_repo: repo }));
            })
            .catch((e) => fail(502, `could not reach the directory (${e.message || e})`));
        });
        };
      });
      return;
    }
    // Drop the pending marker so the promote form comes back. This is the exit
    // from a FAILED promotion, and it is deliberately not a general undo: it
    // touches nothing but the marker, so it cannot unmake a rock. The flip
    // clears its own marker on success, and a box that is already a rock never
    // renders the button that reaches this.
    if (edition === 'member' && req.method === 'POST' && path === '/promote/clear') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => t.kind === 'member'); } catch { targets = []; }
        if (!MEMBER_HOST_RE.test(host) || !targets.some((t) => t.host === host)) {
          res.writeHead(400); res.end('host must be a configured <slug>-box target'); return;
        }
        let c;
        try { c = bridge.stream(host, PROMOTE_PENDING_CLEAR_CMD); }
        catch (e) { res.writeHead(502); res.end(`could not reach the mineral (${e.message || e})`); return; }
        c.on('error', (e) => { res.writeHead(502); res.end(`could not reach the mineral (${e.message || e})`); });
        c.on('close', (code) => {
          if (code !== 0) { res.writeHead(500); res.end(`could not clear the pending promotion (exit ${code})`); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      return;
    }
    if (edition === 'member' && req.method === 'GET' && path === '/promote/status') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[a-f0-9]{16,64}$/.test(id)) { res.writeHead(400); res.end('bad id'); return; }
      const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
      fetch(`${dir}/build-progress?id=${id}`)
        .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
        .catch((e) => { res.writeHead(502); res.end(`could not reach the directory (${e.message || e})`); });
      return;
    }
    if (edition === 'member' && req.method === 'POST' && path === '/promote/flip') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        const id = String(form.id ?? '');
        const handle = String(form.org_handle ?? '').trim();
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => t.kind === 'member'); } catch { targets = []; }
        if (!MEMBER_HOST_RE.test(host) || !targets.some((t) => t.host === host)) {
          res.writeHead(400); res.end('host must be a configured <slug>-box target'); return;
        }
        if (!/^[a-f0-9]{16,64}$/.test(id) || !ORG_RE.test(handle)) {
          res.writeHead(400); res.end('bad id or org handle'); return;
        }
        const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
        fetch(`${dir}/build-progress?id=${id}`)
          .then((r) => r.json())
          .then((rec) => {
            if (!rec || rec.done !== true) { res.writeHead(409); res.end('the promotion is not fulfilled yet; the mineral stays a pebble until the org-side work finishes'); return; }
            // A reconstructed record is NOT consent. `durable: true` means the
            // worker rebuilt this from a 400-day "a mineral was once built here"
            // marker, and the promote id is derived from (email, handle) alone —
            // so after a retire and a re-promote to the same handle, that marker
            // would silently approve a second, payment-gated promotion. Say so
            // plainly instead of flipping.
            if (rec.durable === true) {
              res.writeHead(409);
              res.end('this promotion was completed before and the record of it has aged; ask Crads AI to stage a fresh one. Your mineral stays exactly as it is.');
              return;
            }
            const out = [];
            let settled = false;
            const fail = (code, msg) => { if (settled) return; settled = true; res.writeHead(code); res.end(msg); };
            // SELF-REGISTRATION, the first leg (ruling 2026-08-17): the box
            // mints and keeps its own org token, and the app claims the
            // reserved handle with it before anything on the box changes. A
            // refused claim leaves an honest pebble (plus one unused token in
            // its .env, harmless and reused on retry); a crashed retry
            // re-registers idempotently because the token is persisted FIRST
            // and the worker answers already:true to the same token.
            const registerThenContinue = async () => {
              const ml = [];
              const minted = await new Promise((resolve) => {
                let m;
                try { m = bridge.stream(host, PROMOTE_MINT_CMD, { onStdout: (l) => ml.push(l), onStderr: (l) => ml.push(l) }); }
                catch (e) { resolve({ err: e.message || String(e) }); return; }
                m.on('error', (e) => resolve({ err: e.message || String(e) }));
                m.on('close', () => {
                  const line = ml.find((l) => l.startsWith('PROMOTE_REG '));
                  if (!line) { resolve({ err: ml.join(' ').slice(-160) || 'no output' }); return; }
                  try { resolve(JSON.parse(line.slice('PROMOTE_REG '.length))); } catch { resolve({ err: 'unreadable mint output' }); }
                });
              });
              if (minted.err || !minted.token) { fail(502, `the mineral could not mint its own key (${minted.err || 'empty token'}); nothing has been changed`); return; }
              const idToken = typeof opts.promoteIdToken === 'function' ? await opts.promoteIdToken().catch(() => '') : '';
              if (!idToken) { fail(501, 'this session cannot sign you in to claim your handle; open the app and try again. Nothing has been changed.'); return; }
              const slug = host.replace(/-box$/, '');
              const reg = await fetch(`${dir}/register`, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' },
                body: JSON.stringify({ org: handle, rock_ssh_host: `${slug}.${minted.domain || 'crads-ai.com'}`,
                  org_display: handle, pull_token: minted.token }),
              }).catch((e) => ({ ok: false, status: 0, _err: e.message || String(e) }));
              if (!reg.ok) {
                const detail = typeof reg.json === 'function' ? await reg.json().catch(() => ({})) : {};
                fail(reg.status === 409 ? 409 : 502,
                  `your handle could not be claimed (${detail.error || reg._err || reg.status}); the mineral stays a pebble and nothing has been changed`);
                return;
              }
              unanchorThenFlip().catch((e) => fail(500, `promotion could not finish: ${e.message || e}`));
            };
            const runFlip = () => {
              let flip;
              try {
                flip = bridge.stream(host, promoteFlipCmd(handle), { onStdout: (l) => out.push(l), onStderr: (l) => out.push(l) });
              } catch (e) { fail(500, `flip failed: ${e.message || e}`); return; }
              flip.on('error', (e) => fail(500, `flip failed: ${e.message || e}`));
              flip.on('close', (code) => {
                if (settled) return; settled = true;
                if (code !== 0) { res.writeHead(500); res.end(`flip failed on the mineral (exit ${code}): ${out.join(' ').slice(0, 200)}`); return; }
                try { if (typeof opts.onPromoted === 'function') opts.onPromoted(host, handle); } catch { /* face registry is best-effort */ }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, host, org: handle, msg: 'this mineral is now your rock\'s rock, and your personal seat stays' }));
              });
            };
            // THE ANCHOR COMES OFF BEFORE THE TIER GOES ON (ruling 2026-08-10),
            // in an order that is not arbitrary:
            //   1. downgrade the directory edge anchored -> joined, with the
            //      MEMBER's own id token (their tie, their call, and the rock
            //      already consented to the stronger version of it)
            //   2. publish the leave + detach the channel on the box
            //   3. flip the tier
            // Reversing 1 and 2 loses the community join: the old rock's
            // leave-reconcile reflects the row as `left`, and a `left` reflect
            // prunes an edge that is still anchored. Downgraded first, it is a
            // joined edge, which that path now deliberately keeps.
            //
            // Step 1 is FAIL-CLOSED. If the edge cannot be downgraded, nothing
            // on the box is touched: a rock that still reads as anchored on the
            // wire is the illegal state, and it is also the one where the old
            // rock keeps being charged for a seat that no longer exists.
            const unanchorThenFlip = async () => {
              const anchoredTo = await new Promise((resolve) => {
                const lines = [];
                let probe;
                try {
                  probe = bridge.stream(host, 'cat /state/ownership.json 2>/dev/null', { onStdout: (l) => lines.push(l), onStderr: (l) => lines.push(l) });
                } catch { resolve(null); return; }
                probe.on('error', () => resolve(null));
                probe.on('close', () => {
                  const own = parseOwnership(lines.join('\n'));
                  if (!own) { resolve(null); return; }
                  const a = String(own.anchor || 'crads-ai');
                  resolve(a === 'crads-ai' ? '' : a);
                });
              });
              if (anchoredTo === null) { fail(502, "could not read the mineral's ownership record, so the anchor could not be checked; nothing has been changed"); return; }
              if (!anchoredTo) { runFlip(); return; }
              const idToken = typeof opts.promoteIdToken === 'function' ? await opts.promoteIdToken().catch(() => '') : '';
              if (!idToken) { fail(501, 'this session cannot sign you in to end the anchor, and promotion cannot leave you anchored to a rock. Open the app and try again; nothing has been changed.'); return; }
              // NAME THE MINERAL BEING PROMOTED (2026-08-16, finding 152's
              // sibling). The body was org-only, so a member with two pebbles
              // on that rock had the directory sort and pick: the promoting
              // mineral could keep an anchor a rock may not hold, while the
              // OTHER pebble quietly lost its anchor, its host and the seat its
              // rock was paying for. `host` is a configured <slug>-box target,
              // which the directory reduces to the same label it matches ties
              // on — and it only ever selects among ties this signed-in member
              // already holds, so it cannot reach anybody else's mineral. Sent
              // as box_host rather than slug on purpose: a registry slug renamed
              // by a collision still matches through the edge's box.
              const dg = await fetch(`${dir}/rock-tie-downgrade`, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' },
                body: JSON.stringify({ org: anchoredTo, box_host: host }),
              }).catch((e) => ({ ok: false, status: 0, _err: e.message || String(e) }));
              if (!dg.ok) {
                const detail = typeof dg.json === 'function' ? await dg.json().catch(() => ({})) : {};
                fail(dg.status === 409 ? 409 : 502,
                  `the anchor to "${anchoredTo}" could not be ended (${detail.error || dg._err || dg.status}), and a rock cannot stay anchored to a rock. Nothing has been changed on your mineral.`);
                return;
              }
              const dl = [];
              let det;
              try {
                det = bridge.stream(host, PROMOTE_UNANCHOR_CMD, { onStdout: (l) => dl.push(l), onStderr: (l) => dl.push(l) });
              } catch (e) { fail(500, `the anchor could not be detached on the mineral (${e.message || e}); the join to "${anchoredTo}" is now a community one and the mineral is still a pebble`); return; }
              det.on('error', (e) => fail(500, `the anchor could not be detached on the mineral (${e.message || e}); the join to "${anchoredTo}" is now a community one and the mineral is still a pebble`));
              det.on('close', (c) => {
                if (settled) return;
                if (c !== 0) { fail(500, `the anchor could not be detached on the mineral (exit ${c}): ${dl.join(' ').slice(0, 200)}`); return; }
                runFlip();
              });
            };
            registerThenContinue().catch((e) => fail(500, `promotion could not finish: ${e.message || e}`));
          })
          .catch((e) => { res.writeHead(502); res.end(`could not reach the directory (${e.message || e})`); });
      });
      return;
    }

    // D52 cross-surface nav: every surface can jump back to the app's home
    // screen (the door / identity picker) when it's running in this session.
    // The console's route to the own-brain (GitHub backup) flow, which lives on the
    // member-connect server. Added 2026-07-30: that flow was reachable ONLY from the
    // claim page, so a member who skipped it, or whose box predates it, had no way
    // back to it. Falls back to the door rather than 404ing, same no-cul-de-sac rule.
    if (req.method === 'GET' && path === '/go/connect') {
      const cu = typeof opts.connectUrl === 'function' ? opts.connectUrl() : opts.connectUrl;
      const du = typeof opts.doorUrl === 'function' ? opts.doorUrl() : opts.doorUrl;
      // Carry the box across the hop (2026-08-05). The own-brain form asks for a
      // "short username" it describes as being on your invite, which a self-serve
      // owner never had; the seat already knows the alias, so send the slug and let
      // the landing page fill it in. Anything that is not a slug is dropped rather
      // than passed on: this string lands in a URL fragment on another server.
      // The #ownbrain fragment is gone (2026-08-09): GitHub backup lives in the
      // box's own app, and the invite page was cut back to the invite claim, so
      // there is no fold here to open. /go/connect stays as the honest route to
      // the invite page itself (the door's "I have an invitation" and the
      // #join= community hand-off both use it).
      const to = cu || du;
      if (to) { res.writeHead(302, { location: to }); res.end(); return; }
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('The setup window is not running. Close and reopen the Crads-AI app, then try again.');
      return;
    }
    if (req.method === 'GET' && path === '/door') {
      const du = typeof opts.doorUrl === 'function' ? opts.doorUrl() : opts.doorUrl;
      if (du) { res.writeHead(302, { location: du }); res.end(); }
      // A bare 404 here strands the member: this is the ONE link out of the
      // console (2026-07-30). Serve a real page that explains and offers the
      // surfaces that ARE running, so the app is never a cul-de-sac.
      else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Start screen</title>'
          + '<body style="margin:0;font:15px/1.6 Inter,system-ui,sans-serif;padding:40px 24px;background:#F7F5EF;color:#1F2D24">'
          + '<div style="max-width:520px;margin:auto;background:#fff;border:1px solid #E3E1D6;border-radius:14px;padding:22px">'
          + '<h1 style="font-size:19px;margin:0 0 8px">The start screen is not open in this session</h1>'
          + '<p style="color:#5C6B60;margin:0 0 16px">That is where new minerals and invitations live. Close and reopen the app to get it back.</p>'
          + '<p style="margin:0"><a href="/console" style="color:#A4582C">Back to your mineral</a>'
          + ' &nbsp;·&nbsp; <a href="/panel.html" style="color:#A4582C">Your full app</a></p>'
          + '</div></body>');
      }
      return;
    }


    if (req.method === 'GET' && path === '/whats-new') {
      // the version chip's fold: recent release subjects from the rolling
      // release's changelog.json (CI-published). Empty list offline, never 500 —
      // "where are we up to" must not depend on the network being kind.
      // plainRelease() filters the internal half (QA runs, design notes, merges)
      // and tidies the rest: the people on the far end of this page are running a
      // business, not this repo.
      const get = opts.changelog || fetchChangelog;
      Promise.resolve(get()).then((entries) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(plainRelease(entries || [])));
      }).catch(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ entries: [], hidden: 0 }));
      });
      return;
    }
    if (req.method === 'GET' && path === '/update-status') {
      // opts.updater: { status: {available, current, latest}, apply(), refresh?() } from
      // app.mjs. Each poll nudges a (throttled) re-check so a long-lived process
      // still notices releases published after it started.
      // AWAIT the re-check so the first answer is the true one: this endpoint used
      // to kick a refresh and reply with the previous value, so a freshly
      // published build read as "no update available" until a second poll
      // (2026-07-30).
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify((opts.updater && opts.updater.status) || { available: false }));
      };
      if (opts.updater && opts.updater.refresh) {
        Promise.resolve(opts.updater.refresh()).then(answer).catch(answer);
      } else answer();
      return;
    }
    // Where the open page follows the update to. Polled after a successful apply:
    // 'ready' carries the new instance's url, and the page navigates itself there,
    // so there is one window throughout instead of a second one appearing.
    if (req.method === 'GET' && path === '/update-handoff') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify((opts.updater && opts.updater.handoff) || { phase: 'idle' }));
      return;
    }
    if (req.method === 'POST' && path === '/update-apply') {
      const u = opts.updater;
      if (!u || !u.apply || !u.status || !u.status.available) {
        res.writeHead(400); res.end('no update available'); return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('updating; the app will close and reopen itself in a few seconds');
      u.apply().catch((e) => console.error(`update failed: ${e.message || e}`));
      return;
    }
    if (req.method === 'GET' && path === '/targets') {
      let targets = [];
      try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
      // Ownership of the hosting infrastructure (2026-08-09): a rock this
      // computer provisioned has a local state record and its admin holds the
      // cloud codes; a HOSTED rock does not, and its Danger tab must offer the
      // platform's deletion ladder instead of demanding codes the owner never
      // had. Only stamped for rock-kind targets; absent hook leaves the
      // field off entirely (older app shells keep today's behaviour).
      if (edition === 'org' && typeof opts.orgProvisioned === 'function') {
        targets = targets.map((t) => (/-rock$/.test(String(t.host))
          ? { ...t, provisioned: !!opts.orgProvisioned(String(t.host).replace(/-rock$/, '')) }
          : t));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ targets, role, roleAssumed, edition,
        wizardUrl: (typeof opts.wizardUrl === 'function' ? opts.wizardUrl() : opts.wizardUrl) || null,
        doorUrl: (typeof opts.doorUrl === 'function' ? opts.doorUrl() : opts.doorUrl) || null }));
      return;
    }

    // Re-trust a rebuilt box (2026-07-30). Providers recycle addresses, so a
    // rebuilt box can inherit an IP this computer already trusts under the old
    // box's key, and ssh then refuses it as a possible man-in-the-middle. The
    // member cannot fix that from inside the box (it is what is unreachable), so
    // the app drops the stale key LOCALLY. Nothing about the box changes, and
    // only the address in this app's own config can be forgotten.
    // "Download a copy" (2026-07-30). The GitHub backup answers members who have a
    // GitHub account; most of the people this product is for do not. This is the
    // no-account answer: their whole brain as one file, on their own machine, any time.
    //
    // WHAT IS LEFT BEHIND, deliberately: the credential-shaped material (.env,
    // secrets/, keys, .claude-auth, .kernel) and .git. Dropping .git costs them the
    // history, which they have on GitHub anyway if they use it, and buys the guarantee
    // that a secret committed once in the past cannot ride out inside a zip in their
    // Downloads folder. The card says so rather than leaving them to assume.
    if (edition === 'member' && path.startsWith('/own-brain/') && ownBrainRoute(req, res, path)) return;
    // The rock's own GitHub, org edition only: a member has no factory to arm.
    if (edition === 'org' && path.startsWith('/org-github/') && orgGitHubRoute(req, res, path)) return;
    // Not awaited: this dispatcher is not async, and the handler owns its own
    // response. A rejection must still answer, or the page waits forever on a
    // request that already failed.
    if (path.startsWith('/mcp-oauth/')) {   // both editions since P2: the rock connects its own MCPs
      mcpOAuthRoute(req, res, path).catch((e) => {
        try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) })); } catch { /* already answered */ }
      });
      return;
    }

    // BYO Google: both editions, matching /mcp-oauth/ since P2 (the rock is a
    // pebble-plus and connects its own Google the same way). The handler owns
    // its response and answers synchronously; the flow itself runs background.
    if (path.startsWith('/google-connect/') && googleConnectRoute(req, res, path)) return;

    if (path.startsWith('/mcp-dir/')) {    // both editions: the rock browses the same directory
      mcpDirRoute(req, res, path).catch((e) => {
        try { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) })); } catch { /* already answered */ }
      });
      return;
    }

    if (req.method === 'GET' && path === '/brain-download' && edition === 'member') {
      (async () => {
        const want = String(url.searchParams.get('box') || '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
        const t = want ? targets.find((x) => x.host === want) : targets[0];
        if (!t) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('no mineral to download from'); return; }
        const EXCL = ['.git', '.env', '.env.*', 'secrets', '*.key', '*.pem', '.ssh', 'ssh',
          '.claude-auth', '.claude-auth*', '.kernel', '.mcp.json', 'node_modules', 'cockpit'];
        const excl = EXCL.map((p) => `--exclude=${p}`).join(' ');
        const pick = 'if [ -d /state/brain ]; then BR=/state/brain; else BR=/state; fi';
        // Probe FIRST: once bytes start flowing the status code is already sent, so a
        // failure after that reads as a truncated file rather than an error.
        const probe = opts.downloadProbe || runSsh;
        const ok = await probe(t.host, `${pick}; test -d "$BR" && echo READY`).catch(() => null);
        if (!ok || !/READY/.test(String(ok.stdout || ''))) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Could not reach your mineral just now. Try again in a moment.');
          return;
        }
        const slug = t.host.replace(/-box$/, '');
        const stamp = new Date().toISOString().slice(0, 10);
        const raw = opts.downloadStream || rawSsh;
        const pebble = await raw(t.host, `${pick}; tar czf - -C "$BR" ${excl} . 2>/dev/null`,
          { configPath: join(opts.sshDir || join(homedir(), '.ssh'), 'config') });
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${slug}-brain-${stamp}.tar.gz"`,
          'cache-control': 'no-store',
        });
        pebble.stdout.pipe(res);
        pebble.on('error', () => { try { res.end(); } catch { /* already gone */ } });
        req.on('close', () => { try { pebble.kill('SIGKILL'); } catch { /* gone */ } });
      })();
      return;
    }
    // A6: relay the member's hand-over ask to the directory. Done server-side rather
    // than from the page so the page never needs the directory's address, and so the
    // slug is taken from the CONFIGURED target rather than anything the page typed:
    // a member can only ever ask on behalf of a box this machine actually holds a key
    // for. The ask moves no custody; the org must agree and the member must then
    // accept on the box itself.
    if (req.method === 'POST' && path === '/handover-ask' && edition === 'member') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let form;
          try { form = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
          const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
          const host = String(form.host || '');
          let targets = [];
          try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
          const t = targets.find((x) => x.host === host) || targets[0];
          if (!t) { json(400, { error: 'no mineral on this computer to hand over' }); return; }
          const org = String(form.org || '').trim().toLowerCase();
          if (!ORG_RE.test(org)) { json(400, { error: 'that does not look like a rock handle' }); return; }
          const slug = t.host.replace(/-box$/, '');
          const who = await (opts.handoverIdentity || (async () => ({})))(t).catch(() => ({}));
          const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
          // The directory now demands a verified identity for this ask, because
          // it used to take none at all and an admin's console rendered whatever
          // arrived as "they ask you to own their mineral". Local key-possession
          // (checked above) proves the box; it cannot prove the PERSON, and the
          // person is what the admin acts on. Same sign-in the join flow uses.
          // It also retires the placeholder address this route used to send
          // (`<slug>@crads-ai.com`), which put a fabricated email on that card.
          const signIn = opts.handoverSignIn || (await import('./crads-account.mjs')).signInWithCrads;
          // BIND THE SIGN-IN TO THIS ORG, with the same deterministic nonce the join
          // flow uses: the OIDC nonce commits the signed token to the handle, so a
          // token captured for org A cannot be replayed as an ask at org B.
          //
          // It is also REQUIRED: signInWithGoogle refuses outright without a nonce
          // ("a nonce (the device fingerprint) is required"). The first cut of this
          // called signIn({}), so every real member pressing "Ask them" got a 401
          // and the whole handover path was dead. The tests did not catch it
          // because they stub handoverSignIn, which is exactly what a stub hides.
          const { joinNonce } = await import('./member-connect.mjs');
          let signed;
          try { signed = await signIn({ nonce: joinNonce(org) }); } catch (e) { signed = { ok: false, reason: String(e && e.message || e) }; }
          if (!signed || !signed.ok) {
            json(401, { error: 'sign in to ask a rock to take this box: they need to know who is asking. ' + (signed && signed.reason ? '(' + signed.reason + ')' : '') });
            return;
          }
          try {
            const r = await fetch(`${dir}/handover-request`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.idToken}` },
              body: JSON.stringify({ org, slug, name: who.name || slug, note: String(form.note || '').slice(0, 400) }),
            });
            const b = await r.json().catch(() => ({}));
            if (!r.ok) { json(r.status === 404 ? 404 : 400, { error: b.error || `that rock did not accept the ask (${r.status})` }); return; }
            json(200, { ok: true, id: b.id, org });
          } catch {
            json(502, { error: 'could not reach the directory just now. Try again in a moment.' });
          }
        })();
      });
      return;
    }
    // ---- rock ties (rulings 2026-08-05 + 2026-08-09): the board, the two asks
    // (JOIN moves nothing; ANCHOR moves hosting + platform billing onto the rock,
    // never ownership), the leave, and the member's own ties. Same server-side
    // posture as /handover-ask: the page never learns the directory's address,
    // and the slug always comes from the CONFIGURED box, never the page.
    // Transfer CONSENT (Harriet's audit 2026-08-19, point 3). Accepting a
    // transfer-to-org used to be one verb that ran a script on the box, and a
    // support session could run that script. Now the app, signed in as the
    // member, records the consent at the directory first (nonce-bound to the
    // anchoring rock, bound to this box's holder), and only the RECEIPT goes to
    // the box script, which refuses without one. The invitation date and the
    // rock come from the BOX (its own inbox + ownership record), never the page:
    // a page cannot consent for a box this machine does not hold a key for.
    if (req.method === 'POST' && path === '/transfer-consent' && edition === 'member') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let form;
          try { form = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
          const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
          const host = String(form.host || '');
          let targets = [];
          try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
          const t = targets.find((x) => x.host === host) || targets[0];
          if (!t) { json(400, { error: 'no mineral on this computer to accept a transfer for' }); return; }
          const slug = t.host.replace(/-box$/, '');
          // what the box knows: the invitation it holds and the rock that anchors it
          const probe = opts.transferProbe || runSsh;
          let inv = null, own = null;
          try {
            const r = await probe(t.host, 'node -e \'const fs=require("fs");const j=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};console.log("TRANSFER_STATE "+JSON.stringify({inv:j("/state/org-inbox/transfer/to-org.json"),own:j("/state/ownership.json")}))\'');
            const line = String(r && r.stdout || '').split('\n').find((l) => l.startsWith('TRANSFER_STATE '));
            if (line) { const st = JSON.parse(line.slice('TRANSFER_STATE '.length)); inv = st.inv; own = st.own; }
          } catch { /* unreachable box: handled below */ }
          if (!inv || !/^\d{4}-\d{2}-\d{2}$/.test(String(inv.invited || ''))) { json(409, { error: 'your mineral holds no transfer invitation from your rock; there is nothing to accept' }); return; }
          const org = String(inv.org_slug || (own && own.anchor) || '').trim().toLowerCase();
          if (!org || org === 'crads-ai' || !ORG_RE.test(org)) { json(409, { error: 'this mineral is not anchored to a rock, so no rock can take custody of it' }); return; }
          const signIn = opts.handoverSignIn || (await import('./crads-account.mjs')).signInWithCrads;
          const { joinNonce } = await import('./member-connect.mjs');
          let signed;
          try { signed = await signIn({ nonce: joinNonce(org) }); } catch (e) { signed = { ok: false, reason: String(e && e.message || e) }; }
          if (!signed || !signed.ok) { json(401, { error: 'sign in to accept: your own sign-in is what makes this transfer yours to give. ' + (signed && signed.reason ? '(' + signed.reason + ')' : '') }); return; }
          const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
          try {
            const r = await fetch(`${dir}/transfer-consent`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.idToken}` },
              body: JSON.stringify({ org, slug, host: t.host, invited: String(inv.invited) }),
            });
            const b = await r.json().catch(() => ({}));
            if (!r.ok || !/^[0-9a-f]{32}$/.test(String(b.receipt || ''))) { json(r.status === 404 ? 404 : 400, { error: b.error || `the directory did not record the consent (${r.status})` }); return; }
            json(200, { ok: true, receipt: b.receipt, org, invited: String(inv.invited) });
          } catch {
            json(502, { error: 'could not reach the directory just now. Try again in a moment.' });
          }
        })();
      });
      return;
    }
    if (req.method === 'GET' && path === '/rocks-board') {   // both faces read the public board (P3)
      const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
      (async () => {
        try {
          const r = await (opts.communityFetcher || fetch)(`${dir}/rocks`);
          const b = await r.json().catch(() => ({}));
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.ok ? { rocks: Array.isArray(b.rocks) ? b.rocks : [] } : { error: 'the rock board did not answer' }));
        } catch {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'could not reach the directory just now. Try again in a moment.' }));
        }
      })();
      return;
    }
    if (req.method === 'POST' && (path === '/rock-join-ask' || (path === '/rock-anchor-ask' && edition === 'member'))) {
      if (edition !== 'member' && role === 'support') { res.writeHead(403); res.end(JSON.stringify({ error: 'this action needs an Admin login' })); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let form;
          try { form = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
          const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
          const host = String(form.host || '');
          let targets = [];
          try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
          const t = targets.find((x) => x.host === host) || targets[0];
          if (!t) { json(400, { error: 'no mineral on this computer to ask with' }); return; }
          const org = String(form.org || '').trim().toLowerCase();
          if (!ORG_RE.test(org)) { json(400, { error: 'that does not look like a rock handle' }); return; }
          const tie = path === '/rock-anchor-ask' ? 'anchored' : 'joined';
          const slug = t.host.replace(/-(box|rock)$/, '');
          // A ROCK CANNOT JOIN ITSELF (Sam, 2026-08-10). The worker's cycle
          // guard already says "a mineral cannot join itself", but it is wired
          // to the org-to-org /requests family and never ran on this route, so
          // the Rocks page happily offered a rock its own handle. Refused here
          // as well as there: this is the surface that can tell the person why
          // in the same breath, and it ships without a worker deploy.
          if (org === slug) {
            json(400, { error: 'That is this rock. A rock cannot join itself; pick another rock\u2019s handle.' });
            return;
          }
          const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
          // Same verified identity the handover ask demands, nonce-bound to the
          // handle, because the org admin acts on the PERSON asking.
          const signIn = opts.communitySignIn || (await import('./crads-account.mjs')).signInWithCrads;
          const { joinNonce } = await import('./member-connect.mjs');
          let signed;
          try { signed = await signIn({ nonce: joinNonce(org) }); } catch (e) { signed = { ok: false, reason: String(e && e.message || e) }; }
          if (!signed || !signed.ok) {
            json(401, { error: 'sign in to ask: the rock needs to know who is asking. ' + (signed && signed.reason ? '(' + signed.reason + ')' : '') });
            return;
          }
          try {
            const r = await (opts.communityFetcher || fetch)(`${dir}/rock-tie-request`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.idToken}` },
              body: JSON.stringify({ org, slug, tie, note: String(form.note || '').slice(0, 400), ...(form.share_contact === true ? { share_contact: true } : {}), ...(edition === 'member' ? {} : { tier: 'rock' }) }),
            });
            const b = await r.json().catch(() => ({}));
            // 409s carry the model's own words (anchored elsewhere / owner-rock) — pass them through.
            if (!r.ok) { json(r.status === 404 ? 404 : r.status === 409 ? 409 : 400, { error: b.error || `that rock did not accept the ask (${r.status})` }); return; }
            json(200, { ok: true, id: b.id, org, tie });
          } catch {
            json(502, { error: 'could not reach the directory just now. Try again in a moment.' });
          }
        })();
      });
      return;
    }
    // R23 (panel iteration 2, 2026-08-23): "Change to join" on the anchored
    // row. Member-initiated, member-authenticated, exactly the worker leg the
    // promotion flow already drives: the anchor becomes a join, hosting and
    // billing return to Crads AI. Same sign-in and forwarding shape as
    // /rock-anchor-ask; 4xx bodies pass through in the directory's own words.
    // On success the cached edge flips and the box's ties.json is rewritten so
    // the Map stops drawing an anchor the directory no longer holds.
    if (req.method === 'POST' && path === '/rock-tie-downgrade' && edition === 'member') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let form;
          try { form = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
          const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
          const host = String(form.host || '');
          let targets = [];
          try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
          const t = targets.find((x) => x.host === host) || targets[0];
          if (!t) { json(400, { error: 'no mineral on this computer to change' }); return; }
          const org = String(form.org || '').trim().toLowerCase();
          if (!ORG_RE.test(org)) { json(400, { error: 'that does not look like a rock handle' }); return; }
          const slug = t.host.replace(/-(box|rock)$/, '');
          const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
          const signIn = opts.communitySignIn || (await import('./crads-account.mjs')).signInWithCrads;
          const { joinNonce } = await import('./member-connect.mjs');
          let signed;
          try { signed = await signIn({ nonce: joinNonce(org) }); } catch (e) { signed = { ok: false, reason: String(e && e.message || e) }; }
          if (!signed || !signed.ok) {
            json(401, { error: 'sign in to change the tie: it is keyed to your verified email. ' + (signed && signed.reason ? '(' + signed.reason + ')' : '') });
            return;
          }
          try {
            // box_host names the mineral, as the promotion leg does: a slug
            // renamed by a collision still matches through the edge's box.
            const r = await (opts.communityFetcher || fetch)(`${dir}/rock-tie-downgrade`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.idToken}` },
              body: JSON.stringify({ org, box_host: t.host }),
            });
            const b = await r.json().catch(() => ({}));
            if (!r.ok) { json(r.status >= 400 && r.status < 500 ? r.status : 502, { error: b.error || `the directory refused (${r.status})` }); return; }
            const st = server._communityMine;
            if (st && Array.isArray(st.edges)) {
              for (const x of st.edges) {
                if (x.org === org && x.rel === 'anchored'
                  && (String(x.slug || '') === slug || String(x.box || '').indexOf(slug) === 0)) x.rel = 'joined';
              }
            }
            // The box-side half (R23): the directory now says joined and
            // anchored-to-the-Mountain; the box must stop feeding its old
            // anchor (heartbeat + inbox confs and keys) and record the Mountain
            // in its own ownership.json, exactly as the promotion leg does.
            // Retryable: the command exits 0 with nothing done when the confs
            // are already gone.
            const dl = [];
            let detach = 'UNANCHOR-SKIPPED';
            try {
              await bridge.stream(t.host, unanchorCmd('downgrade'), { onStdout: (l) => dl.push(l), onStderr: (l) => dl.push(l) });
              detach = dl.find((l) => /^UNANCHOR-/.test(l)) || dl.slice(-1)[0] || 'UNANCHOR-OK';
            } catch (e) { detach = 'UNANCHOR-FAILED: ' + String(e && e.message || e); }
            await syncTiesToBox(t.host, true);
            json(200, { ...b, ok: true, org, host: t.host, detach });
          } catch {
            json(502, { error: 'could not reach the directory just now. Try again in a moment.' });
          }
        })().catch(() => { try { res.writeHead(500); res.end(JSON.stringify({ error: 'request failed' })); } catch { /* answered */ } });
      });
      return;
    }
    if (req.method === 'POST' && path === '/rock-leave') {   // a rock leaves a joined rock the same way (P3)
      if (edition !== 'member' && role === 'support') { res.writeHead(403); res.end(JSON.stringify({ error: 'this action needs an Admin login' })); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        (async () => {
          let form;
          try { form = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' })); return; }
          const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
          const org = String(form.org || '').trim().toLowerCase();
          if (!ORG_RE.test(org)) { json(400, { error: 'that does not look like a rock handle' }); return; }
          const tie = String(form.tie || '');
          if (tie !== 'joined' && tie !== 'anchored') { json(400, { error: 'tie must be joined or anchored' }); return; }
          // WHICH MINERAL LEAVES (2026-08-16, finding 152's sibling). A tie kind
          // is not a mineral name: since one person may hold two pebbles on one
          // rock, org+tie can match two rows, and the directory used to sort and
          // delete the newest. Every row the Rocks page draws comes from
          // /rock-mine, which returns the slug, so the page says which one. The
          // directory refuses (409) when nothing is named and two match, and its
          // words are already passed straight through below.
          const slug = String(form.slug || '');
          if (slug && !MINERAL_RE.test(slug)) { json(400, { error: 'that does not look like a mineral name' }); return; }
          const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
          const signIn = opts.communitySignIn || (await import('./crads-account.mjs')).signInWithCrads;
          const { joinNonce } = await import('./member-connect.mjs');
          let signed;
          try { signed = await signIn({ nonce: joinNonce(org) }); } catch (e) { signed = { ok: false, reason: String(e && e.message || e) }; }
          if (!signed || !signed.ok) {
            json(401, { error: 'sign in to leave: the tie is keyed to your verified email. ' + (signed && signed.reason ? '(' + signed.reason + ')' : '') });
            return;
          }
          try {
            const r = await (opts.communityFetcher || fetch)(`${dir}/rock-tie-leave`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.idToken}` },
              body: JSON.stringify({ org, tie, ...(slug ? { slug } : {}) }),
            });
            const b = await r.json().catch(() => ({}));
            // a 409 is the ownership refusal (an owned box never leaves by
            // walking away) OR the two-ties-and-no-name refusal; both carry the
            // directory's own words, which is why they are passed through
            if (!r.ok) { json(r.status === 409 ? 409 : 400, { error: b.error || `the directory refused (${r.status})` }); return; }
            // refresh the cached ties so the section repaints honestly, and
            // land the drop on the boxes' ties.json too (R9: the map must not
            // keep drawing a wire the directory has already cut)
            //
            // SLUG-SCOPED, for the same reason the call above is (2026-08-16).
            // Blind to it, this took the FIRST (org, tie) row as `gone` — so the
            // T8 detach below could strip the channel confs and keys off the
            // mineral whose tie still stands — and the filter dropped BOTH rows
            // from the cache, repainting the Rocks page as if two ties ended.
            const st = server._communityMine;
            const isGone = (x) => x.org === org && x.rel === tie && (!slug || String(x.slug || '') === slug);
            const gone = st && Array.isArray(st.edges) ? st.edges.find(isGone) : null;
            if (st && Array.isArray(st.edges)) st.edges = st.edges.filter((x) => !(gone ? x === gone : isGone(x)));
            syncTiesToAll(true);   // a leave is the one act allowed to write an empty ties.json
            // T8 symmetry: an ANCHORED leave detaches the mineral too. The
            // directory edge is already cut (above); leave-org publishes the
            // leave marker up the still-open heartbeat, removes the channel
            // confs + keys, and re-anchors the mineral to the Mountain — the
            // exact reverse of the T6/T7 wire. Best-effort: an offline mineral
            // leaves the channel behind, and the rock's leave-reconcile +
            // the worker's live-edge check on /anchor-wire keep every side
            // honest until it comes back.
            if (edition === 'member' && tie === 'anchored' && gone) {
              (async () => {
                try {
                  let targets = [];
                  try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
                  const slug = String(gone.slug || '');
                  const t = targets.find((tt) => {
                    const h = tt.host.replace(/-box$/, '');
                    return h === slug || String(gone.box || '').indexOf(h) === 0;
                  });
                  if (!t) return;
                  if (server._anchorWired) server._anchorWired.delete(`${org}:${t.host}`);
                  await runCollect(t.host, MEMBER_VERBS['leave-org'].build({ confirm: 'leave' }));
                } catch { /* the mineral detaches when it can */ }
              })();
            }
            // A JOINED leave has a box side too (2026-08-23): tie-claim.mjs
            // gave the mineral an inbox conf, a heartbeat conf and two keys for
            // that rock, and they must go with the edge or org-sync keeps
            // pulling and heartbeat-push keeps pushing to a rock that ended the
            // tie. Best-effort for the same reason as the anchored leg above.
            if (edition === 'member' && tie === 'joined' && gone) {
              (async () => {
                try {
                  let targets = [];
                  try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
                  const slug = String(gone.slug || '');
                  const t = targets.find((tt) => {
                    const h = tt.host.replace(/-box$/, '');
                    return h === slug || String(gone.box || '').indexOf(h) === 0;
                  }) || (targets.length === 1 ? targets[0] : null);
                  if (!t) return;
                  await runCollect(t.host, MEMBER_VERBS['tie-drop'].build({ org }));
                } catch { /* the mineral drops the channel when it can */ }
              })();
            }
            json(200, { ok: true, noop: b.noop === true });
          } catch {
            json(502, { error: 'could not reach the directory just now. Try again in a moment.' });
          }
        })();
      });
      return;
    }
    // The member's own ties + any removal notices, cached server-side after one
    // sign-in (the /my-orgs pattern): token and email never reach the page.
    // rel arrives normalized from /edges (joined/anchored); owner rides along so
    // the page can state the ownership binary in one plain line.
    if (req.method === 'GET' && path === '/rock-mine') {   // both faces: ties are keyed to the signed-in email
      (async () => {
      // Silent staleness repair (2026-08-09 lag audit; T5 lifted the 50-minute
      // ceiling): edges older than 10 minutes re-fetch with NO interactive
      // sign-in — a tie approved on the rock shows up on the next tab-open
      // instead of waiting for a manual refresh. communityToken() re-mints an
      // aged token silently off the disk session, so the repair runs for as
      // long as the account session lives (~60 days), not 50 minutes. The
      // body lives in ensureEdgesFresh since finding 201, shared with the
      // rock face's Network map.
      const st = await ensureEdgesFresh();
      // The sign-in proves the OPERATOR's email, and their edges include any
      // personal pebbles they own. On the rock face only the ROCK's own rows
      // may render — an operator pressing Leave here must never end their own
      // pebble's tie (found by review 2026-08-09) — and a rock can never be
      // anchored, so an anchored row here is by definition not the rock's.
      // A platform lane is not a rock (see PLATFORM_LANES): the edge stays in
      // st.edges for the wiring machinery, but the Rocks page must not draw it.
      // Scoped to THIS route on purpose — /rock-brains and /community-catalogs
      // keep the unfiltered view, so platform-lane content (if any ever ships
      // through those channels) is not silently cut off by a display rule.
      let mine = (st.edges || []).filter((x) => (x.rel === 'joined' || x.rel === 'anchored')
        && !PLATFORM_LANES.has(String(x.org || '').toLowerCase()));
      let notices = st.notices || [];
      if (edition !== 'member') {
        let targetsR = [];
        try { targetsR = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === 'rock'); } catch { targetsR = []; }
        // AND A ROCK IS NOT ITS OWN COMMUNITY MEMBER (finding 202, Sam
        // 2026-08-17, seen on qa-r2-gmail). The slug test answers one question
        // only: is this edge held by the ROCK, or by the operator's personal
        // pebble. It never asks who is at the other end. So the operator's own
        // admin membership of this very rock (org qa-r2-gmail, slug
        // qa-r2-gmail, rel joined) sailed through and drew the rock under its
        // own "Your rocks" with a JOINED chip, on the page whose first line
        // says these are the ones this rock has joined. One-mineral-one-name is
        // what makes slug and org the same string on a rock, so the slug test
        // cannot tell the two apart and the org has to be excluded by name.
        // This is finding 111's rule ("you are not open to yourself"), which
        // reached the board half of this page on 2026-08-13 and not this half.
        //
        // BUT "EXCLUDED BY NAME" MUST MEAN THIS FACE'S NAME, NOT EVERY NAME
        // THIS MACHINE KNOWS (2026-08-18, Sam, flat-earth-society-of-america →
        // qa-r2-gmail). The exclusion above shipped as "drop any row whose org
        // is one of the CONNECTED rocks", and on a machine that drives both
        // ends of a tie that erased the tie itself: rock A's joined row names
        // org B, B is also wired here, row gone. A's Organisations page said
        // nothing was joined while B's member page showed A, and the directory
        // held the edge the whole time. The self-row's real signature is
        // org === slug (one-mineral-one-name), so that is the exclusion; and
        // the page now says WHICH face is asking (?host=), the same per-face
        // scoping orgTopologyWorld has carried since finding 201 — the map
        // half of this same one-way-tie symptom, found a day earlier.
        const qHost = String(url.searchParams.get('host') || '');
        const face = targetsR.find((t) => t.host === qHost);
        const faceSlugs = (face ? [face] : targetsR)
          .map((t) => String(t.org || String(t.host).replace(/-rock$/, '')));
        mine = mine.filter((x) => x.rel === 'joined' && faceSlugs.includes(String(x.slug || ''))
          && String(x.org || '') !== String(x.slug || ''));
        notices = notices.filter((n) => n && faceSlugs.includes(String(n.slug || '')));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        signedIn: !!st.edges, reason: st.reason,
        mine: mine.map((x) => ({ org: x.org, tie: x.rel, slug: x.slug, status: x.status, ...(x.owner ? { owner: x.owner } : {}) })),
        notices,
      }));
      })();
      return;
    }
    if (req.method === 'POST' && path === '/rock-mine/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      (async () => {
        // under the test runner only an INJECTED signer runs — the real one
        // opens a browser and waits 180s, which is a hung suite, not a test
        const signIn = opts.communitySignIn
          || (process.env.NODE_TEST_CONTEXT ? async () => ({ ok: false, reason: 'sign-in stubbed out under the test runner' })
            : (await import('./crads-account.mjs')).signInWithCrads);
        await refreshCommunityMine(signIn);
      })();
      return;
    }
    // Community catalogues (2026-08-09 audit, R9): the manifests of every rock
    // this person is tied to. Public reads at the directory; cached a minute so
    // page refreshes are not fan-out fetches.
    // ---- the public brain, member side (S9): manifests + pages for every
    // tied rock that shares one, proxied with the retained sign-in token (the
    // /community-item pattern) so the tie check runs on the member's identity
    // and neither token nor email ever reaches the page.
    if (req.method === 'GET' && (path === '/rock-brains' || path === '/rock-brain-page')) {
      (async () => {
        const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const st = server._communityMine || {};
        const token = await communityToken();   // T5: silently re-mints past the old 50-min wall
        if (!token) { send({ signedIn: false, error: 'sign-in-needed' }); return; }
        const jf = opts.communityFetcher || fetch;
        const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
        if (path === '/rock-brain-page') {
          const org = String(url.searchParams.get('org') || '');
          const id = String(url.searchParams.get('id') || '');
          try {
            const r = await jf(`${dir}/rock-brain-page?org=${encodeURIComponent(org)}&id=${encodeURIComponent(id)}`,
              { headers: { authorization: `Bearer ${token}` } });
            send(await r.json().catch(() => ({ error: 'unreadable reply' })));
          } catch { send({ error: 'could not reach the directory just now' }); }
          return;
        }
        const mine = (st.edges || []).filter((x) => x.rel === 'joined' || x.rel === 'anchored');
        const orgs = [...new Set(mine.map((x) => String(x.org || '')).filter(Boolean))];
        const rocks = [];
        for (const org of orgs) {
          try {
            const r = await jf(`${dir}/rock-brain?org=${encodeURIComponent(org)}`, { headers: { authorization: `Bearer ${token}` } });
            if (!r.ok) continue;   // 403 = not shared (or tie gone): honestly absent, never an error row
            const b = await r.json().catch(() => null);
            if (b && Array.isArray(b.items)) rocks.push({ org, rock: b.rock || org, updated: b.updated || 0, items: b.items });
          } catch { /* that rock simply does not list this time */ }
        }
        send({ signedIn: true, rocks });
      })();
      return;
    }
    // The rock's OWN published manifest, proxied server-side: the live worker's
    // CORS headers cannot be assumed from the app origin, and a strength-card
    // truth must not depend on them (found by the shots rig, S4).
    if (req.method === 'GET' && path === '/own-catalog') {
      (async () => {
        const org = String(url.searchParams.get('org') || '').replace(/-rock$/, '');
        if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(org)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'bad org' })); return;
        }
        const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
        try {
          const jf = opts.communityFetcher || fetch;
          const r = await jf(`${dir}/community-catalog?org=${encodeURIComponent(org)}`);
          const b = await r.json().catch(() => ({ items: [] }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, items: (b.items || []).length }));
        } catch {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      })();
      return;
    }
    if (req.method === 'GET' && path === '/community-catalogs') {
      (async () => {
        const st = server._communityMine || {};
        let mine = (st.edges || []).filter((x) => x.rel === 'joined' || x.rel === 'anchored');
        if (edition !== 'member') {
          // same narrowing as /rock-mine: only the ROCK's own joined ties here
          let slugs = [];
          try { slugs = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === 'rock')
            .map((t) => String(t.org || String(t.host).replace(/-rock$/, ''))); } catch { slugs = []; }
          mine = mine.filter((x) => x.rel === 'joined' && slugs.includes(String(x.slug || '')));
        }
        const orgs = [...new Set(mine.map((x) => String(x.org || '')).filter(Boolean))];
        const dir = opts.directoryUrl || 'https://directory.crads-ai.com';
        const jf = opts.communityFetcher || fetch;
        const now = Date.now();
        const cache = server._communityCatalogs || (server._communityCatalogs = {});
        const out = [];
        for (const org of orgs) {
          try {
            if (!cache[org] || now - cache[org].at > 60000) {
              const r = await jf(`${dir}/community-catalog?org=${encodeURIComponent(org)}`);
              cache[org] = { at: now, data: await r.json().catch(() => ({ org, items: [] })) };
            }
            if (cache[org].data) out.push(cache[org].data);
          } catch { /* directory unreachable: this rock's section just doesn't render */ }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ signedIn: !!st.edges, catalogs: out.filter((c) => c && (c.items || []).length) }));
      })();
      return;
    }
    // /community-item is GONE with the directory route behind it (one-inbox,
    // 2026-08-17). It fetched a package from the directory so the app could
    // write it to the box. Packages now reach a box one way: the rock
    // materialises them into inbox-<slug> and org-sync mirrors them down.
    // /community-catalogs above survives and is unchanged: browsing a rock's
    // shop window is not acquiring from it.
    if (req.method === 'POST' && path === '/retrust' && edition === 'member') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => matchesKind(t, targetKind)); } catch { targets = []; }
        const t = targets.find((x) => x.host === host);
        if (!hostShapeOk(host) || !t) { res.writeHead(400); res.end('host must be a configured <slug>-box target'); return; }
        // known_hosts keys on the ADDRESS, not the alias, and TWO files matter:
        // this app's own, plus the user's (plain ssh + the Claude Code app).
        const sshDir = opts.sshDir || join(homedir(), '.ssh');
        const addr = hostNameFor(host, join(sshDir, 'config'));
        const files = [appKnownHostsPath(), userKnownHostsPath(sshDir)];
        try {
          for (const f of files) {
            forgetHost(host, f);
            if (addr) forgetHost(addr, f);
          }
        } catch (e) { res.writeHead(500); res.end(String(e.message || e)); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, forgot: [host, addr].filter(Boolean), files: files.length }));
      });
      return;
    }

    // cold-tier loopback routes (member edition only): local crypto around box
    // commands; the org/support edition never gets a decrypt path, by design
    // /vault + self-heal serve BOTH editions since P2 (the org Secrets page
    // seals against the operator roster the same way); the live topology feed
    // stays member-only until the rock Map lands (P3).
    if (req.method === 'POST' && (path.startsWith('/vault/') || path === '/devices/self-heal' || path === '/topology/world')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 3e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === targetKind); } catch { targets = []; }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end(`host must be a configured ${edition === 'member' ? '<slug>-box' : '<org>-rock'} target`); return;
        }
        if (path === '/topology/world') {
          (edition === 'member' ? topologyWorld(host) : orgTopologyWorld(host)).then((r) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
          }, (e) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: String(e.message || e) }));
          });
          return;
        }
        if (path === '/devices/self-heal') {
          devicesSelfHeal(host).then((r) => {
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r.body));
          }, (e) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: String(e.message || e) }));
          });
          return;
        }
        vaultRoute(path, host, form, res);
      });
      return;
    }

    if (req.method === 'POST' && path === '/run') {
      // A cross-origin page can fire a no-preflight "simple" POST at this
      // loopback port; requiring the JSON content-type forces a CORS preflight
      // no hostile page passes. own-brain-routes has carried this guard since
      // it was built — /run, the route that reaches every mutating verb
      // including teardown, only gained it in the 2026-08-10 pebble audit.
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'json only' })); return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }

        const spec = verbs[form.verb];
        if (!spec) { res.writeHead(400); res.end(`unknown verb: ${String(form.verb).slice(0, 60)}`); return; }
        if (spec.adminOnly && role === 'support') {
          res.writeHead(403); res.end(`this action needs an Admin login: you are signed in as Support (verb ${form.verb} is admin-only)`); return;
        }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter((t) => (t.kind || 'rock') === targetKind); } catch { targets = []; }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end(`host must be a configured ${edition === 'member' ? '<slug>-box' : '<org>-rock'} target`); return;
        }
        let built;
        try { built = spec.build(form.args || {}); }
        catch (e) { res.writeHead(e.status === 400 ? 400 : 500); res.end(String(e.message || e)); return; }
        if (spec.adminOnly) {
          // D46 defense-in-depth: re-check the SERVER-authenticated login on the
          // box (AIOS_LOGIN, from sshd via enter-aios). The panel-side 403 above
          // is UI; this line still holds if a Support user drives /run directly.
          // (Full Support confinement is the D46 step-5 build; a support login
          // with a raw shell is not yet restricted beyond this.)
          // The box-side re-check that used to live here named the Support login,
          // which no longer exists (deleted 2026-08-05). Kept as a REFUSAL rather
          // than deleted outright: a rock stamped before today still has the
          // aios-support unix account, with an empty authorized_keys because no
          // Support person was ever created, so nobody can authenticate as it. If
          // one somehow did, every adminOnly verb must still refuse.
          built.command = '[ "${AIOS_LOGIN:-}" != "aios-support" ] || { echo "ERROR: the Support role has been removed; sign in as an Admin"; exit 78; }; ' + built.command;
        }
        if (spec.mutating && busy) {
          res.writeHead(409); res.end('another action is still running: wait for it to finish (watch its log), then try this again'); return;
        }
        if (spec.mutating) busy = true;

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (line) => { try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { /* client gone */ } };
        send(`▸ ${form.verb} @ ${host}`);
        let done = false;
        const finish = (code) => {
          if (done) return; done = true;
          if (spec.mutating) busy = false;
          send(code === 0 ? '__DONE__' : `__FAIL__ exit ${code}`);
          try { res.end(); } catch { /* already closed */ }
        };
        let pebble;
        try {
          pebble = bridge.stream(host, built.command, {
            onStdout: (l) => send(l),
            onStderr: (l) => send(l),
            stdin: built.stdin,
            // A verb that provisions declares its own budget; everything else keeps
            // the short default, so a genuinely hung verb is still killed fast.
            ...(spec.timeoutMs ? { hardTimeoutMs: spec.timeoutMs } : {}),
          });
        } catch (e) { send(`ERROR: ${e.message || e}`); finish(1); return; }
        pebble.on('error', (e) => {
          const help = process.platform === 'win32'
            ? 'Make sure the "OpenSSH Client" is installed (Settings > Apps > Optional features); it ships with Windows 10 and later.'
            : 'SSH comes with your system; if this keeps happening, restart the app and check your internet connection.';
          send(`ERROR: this computer could not start an SSH connection: ${e.message || e}. ${help}`); finish(1);
        });
        pebble.on('close', (code) => finish(code ?? 1));
        // the browser tab closing must not orphan the lock; the remote command
        // itself finishes on its own (matching the wizard's keep-running rule).
        // NB: req 'close' fires when the REQUEST finishes arriving (would kill every
        // verb instantly); res 'close' is the client-went-away signal, guarded by done.
        res.on('close', () => { if (!done && !spec.mutating) { try { pebble.kill(); } catch { /* best-effort */ } } });
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(opts.port ?? 0, opts.host || '127.0.0.1');
  // T5: the amnesia fix. A disk session means the app KNOWS who it is before
  // any button is pressed: seed the identity and pull edges silently at start,
  // so the Rocks tab, the Library and both maps are populated on first paint
  // and the ties land on the boxes (R9) with no sign-in ceremony. The silent
  // mint NEVER opens a browser: a machine with no session keeps exactly the
  // old behaviour (the tab offers Sign in).
  // (under the test runner only an INJECTED account seeds — a developer's own
  // ~/.crads-ai-session.json must never leak network calls into a test run)
  if (edition === 'member' && (opts.accountToken || !process.env.NODE_TEST_CONTEXT)) {
    (async () => {
      try {
        const mint = opts.accountToken || (await import('./crads-account.mjs')).getAppToken;
        const probe = await mint({});
        if (probe && probe.ok && probe.idToken) await refreshCommunityMine(async () => probe);
      } catch { /* the tab offers Sign in */ }
    })();
  }
  return server;
}
