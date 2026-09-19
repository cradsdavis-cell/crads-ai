// panel-server.mjs: the control panel's local loopback server (D43). Same shape
// as the retired wizard/ui server: serves the SPA, streams every verb as SSE. The browser
// NEVER sends shell; it sends { host, verb, args } and only verbs in the MEMBER_VERBS
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
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemBridge, forgetHost, hostNameFor, userKnownHostsPath, appKnownHostsPath, rawSsh, runSsh, matchesKind } from './ssh-bridge.mjs';
import { createOwnBrainRoutes } from './own-brain-routes.mjs';
import { createMcpOAuthRoutes } from './mcp-oauth-routes.mjs';
import { createMcpDirectoryRoutes } from './mcp-directory-routes.mjs';
import { createGoogleConnectRoutes } from './google-connect-routes.mjs';
import { fetchChangelog, plainRelease } from './updater.mjs';
import { seal as sealEnvelope, open as openEnvelope, ensureVaultKeypair } from './vault-crypto.mjs';
import { machineName } from './machine-name.mjs';
import { inventoryRoutes } from './inventory-routes.mjs';
import { writeLastUsed } from './last-used.mjs';
import { BRAIN_ROOT_SH } from '../../engine/lib/brain-root.mjs';
import { crossOriginBlocked, refuseCrossOrigin } from './same-origin.mjs';
import { LOCAL_VERBS } from './local-verbs.mjs';
import { ownBrainDispatch, precheckDispatch } from './local-routes.mjs';

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
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-rock$/;
const MEMBER_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-box$/;      // member edition (D44)
// The no-server face (2026-09-11): a brain FOLDER on this computer, listed by
// local-targets.mjs, served the LOCAL_VERBS table below and nothing that needs
// a box. The suffix is the third alias shape the one face admits.
const LOCAL_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-local$/;
// (The platform-lane set PLATFORM_LANES and the edge machinery that read it
// died with the hosted model: the face collapse removed /rock-mine, ties.json
// syncing and the anchor wiring, 2026-09-01.)
// A host this server may act on. The SUFFIX is a shape check only: a box
// PROMOTED from a pebble keeps its `<slug>-box` alias and is served by the org
// edition, so insisting on `-rock` here rejected every org verb on exactly the
// boxes slice 1 had just taught the app to list. The real authorisation is
// membership of this edition's configured target list, which is strictly
// stronger than any name pattern.
const hostShapeOk = (host) => HOST_RE.test(host) || MEMBER_HOST_RE.test(host) || LOCAL_HOST_RE.test(host);
const B64_RE = /^[A-Za-z0-9+/=\r\n]+$/;
const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]{1,64})?$/;
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

  // What the mineral thinks with (second-harness spec 2026-09-17). The app does shape
  // checks only; the box's own writer (engine/ops/assistant-set.mjs) validates against the
  // harness registry and refuses in words. The payload rides STDIN, never the command line:
  // it can carry an endpoint key, and argv is world-readable on the box while it runs.
  'assistant-set': {
    mutating: true,
    build: (a = {}) => {
      const pick = {};
      for (const k of ['harness', 'source', 'provider', 'id', 'base_url', 'key', 'timeout_s']) {
        if (a[k] == null || a[k] === '') continue;
        const v = String(a[k]);
        if (v.length > 400 || /[\r\n\0]/.test(v)) bad(`${k} is not a single short line`);
        pick[k] = v;
      }
      if (!pick.harness || !pick.source || !pick.provider) bad('harness, source and provider are required');
      return {
        command: '[ -f /app/engine/ops/assistant-set.mjs ] || { echo "ASSISTANT_REFUSED this mineral\'s software is older than this setting: update and restart it first"; exit 2; }; '
          + 'node /app/engine/ops/assistant-set.mjs /state -',
        stdin: Buffer.from(JSON.stringify(pick), 'utf8').toString('base64') + '\n',
      };
    },
  },
  // Probed FROM the mineral: that is where the requests will come from.
  'assistant-probe': {
    build: () => ({
      command: '[ -f /app/engine/ops/assistant-probe.mjs ] && node /app/engine/ops/assistant-probe.mjs /state '
        + '|| echo \'ASSISTANT_PROBE {"ok":false,"detail":"this mineral\\u0027s software is older than this check: update and restart it first","steps":[]}\'',
    }),
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
          + `rm -rf "${D}"; `
          + 'node -e \'const fs=require("fs");const f="/state/cockpit/cadence.json";const id=process.argv[1];'
          + 'let c;try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{c=null}'
          + 'if(c&&typeof c==="object"&&!Array.isArray(c)&&Object.prototype.hasOwnProperty.call(c,id)){delete c[id];'
          + 'const t=f+".tmp."+process.pid;fs.writeFileSync(t,JSON.stringify(c,null,2)+"\\n");fs.renameSync(t,f)}\' '
          + `"${id}" 2>/dev/null || true; `
          + `echo "OK: /${id} removed. That was the only copy."`,
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
        + 'anchored,anchor:(own.anchor&&own.anchor!=="crads-ai"?own.anchor:""),name:nm,backup,custody,'
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
// createPanelServer({ port, host, htmlText|htmlPath, bridge, role, ... })
//                     -> the listening http.Server.
//   bridge     injectable transport (tests); defaults to the system ssh bridge
//   role       'admin' (default) | 'support' (legacy; gates adminOnly verbs)
// The edition option is GONE (face collapse, 2026-09-01): one server serves
// the one face to every mineral, whatever its alias suffix says.
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
  });
  // ONE verb table (face collapse, 2026-09-01): the member table is the
  // floor, plus the Catalogue page's library/commons verbs from the old org
  // table. Everything else that lived in ORG_VERBS (fleet, registry, people,
  // governance, factory) lost its pages and is no longer served; the builders
  // stay exported for their own unit tests until the machinery is deleted.
  // The Catalogue page retired 2026-09-09 (simple assistant), and with it the
  // last dozen owner verbs the one face still served, then the whole owner
  // table (hosted-era people/fleet/transfer/governance verbs nothing had
  // served since 2026-09-01). MEMBER_VERBS is the one table.
  const verbs = MEMBER_VERBS;
  // THE VERB TABLE FOLLOWS THE TARGET'S KIND (2026-09-11). A box, whatever its
  // alias, gets the member table; a local brain folder gets LOCAL_VERBS, a
  // strict subset with no cadence, Telegram, MCP, secrets or devices verbs, so
  // /run's own unknown-verb 400 is what keeps a server-only action off a
  // folder. Nothing else in this file needs to know which face it is on.
  const verbsFor = (host, targets) => {
    const t = (targets || []).find((x) => x && x.host === host);
    return t && matchesKind(t, 'local') ? LOCAL_VERBS : MEMBER_VERBS;
  };
  const isLocalHost = (host, targets) => (targets || []).some((t) => t && t.host === host && matchesKind(t, 'local'));
  // Three alias shapes open the same face: <slug>-box (the ordinary mineral),
  // the legacy <org>-rock, and <slug>-local (a brain folder on this computer).
  // The probe-set promoted flag still admits a promoted host under its -box alias.
  const hostRe = { test: (h) => MEMBER_HOST_RE.test(h) || HOST_RE.test(h) || LOCAL_HOST_RE.test(h) };
  const kindOk = (t) => matchesKind(t, 'member') || matchesKind(t, 'rock') || matchesKind(t, 'local');
  // Host gate: valid = present in the bridge's target list AND (matches an
  // alias shape OR carries the probe-set promoted flag). The flag travels on
  // the target row, which only the server-side face probe writes; request
  // input can never mint one.
  const validTarget = (host, targets) => targets.some((t) => t.host === host && (hostRe.test(host) || t.promoted));
  const role = String(opts.role || 'admin').toLowerCase() === 'support' ? 'support' : 'admin';
  const roleAssumed = !opts.role; // no explicit role given: staging default (Admin), shown as assumed
  const html = () => (opts.htmlText ?? readFileSync(opts.htmlPath || join(HERE, 'member.html')));
  let busy = false; // one mutating verb at a time

  // ---- own-brain, ON THE SEAT (2026-08-05, Sam: "I just want to click a button and
  // connect to GitHub"). The flow used to live only on the member-connect wizard, so
  // the seat's Backup button was a hop to another surface headed "Connect to your mineral",
  // which is the page for someone who does not have one. Same routes, mounted here, so
  // the button runs the flow in place and never leaves the app. Member edition only:
  // an org console has no personal brain to make yours.
  const ownBrainTargets = () => { try { return (bridge.targets() || []).filter(kindOk); } catch { return []; } };
  const ownBrainRoute = createOwnBrainRoutes({
    // A -local alias runs the folder flow (own-brain-local.mjs); a box alias
    // runs own-brain.mjs exactly as before. One Backup button on every face.
    opts: { ...opts,
      ownBrain: ownBrainDispatch({ targets: () => ownBrainTargets().filter((t) => matchesKind(t, 'local')), box: opts.ownBrain }),
      precheckBridge: precheckDispatch({ targets: () => ownBrainTargets().filter((t) => matchesKind(t, 'local')), ssh: opts.precheckBridge }) },
    defaultHost: () => { const t = ownBrainTargets(); return t.length ? t[0].host : null; },
    // Reuses the same gate every other box-addressed route uses, so a caller cannot
    // name a host this app does not manage and have it dialled.
    resolveHost: (want) => (validTarget(want, ownBrainTargets()) ? want : null),
  });

  // ---- MCP sign-in, run by THIS app (2026-08-09) ---------------------------
  // The listener lives here, on the member's own machine, which is the whole
  // point: the CLI's listener ran on the BOX, unreachable from their browser,
  // which is why the old flow ended on a dead localhost page and needed a paste.
  // The token goes to the box the same way every other write does, as a verb
  // over the existing SSH channel, base64 on stdin so it never touches argv.
  const mcpOAuthRoute = createMcpOAuthRoutes({
    sendToBox: async (host, payload) => {
      const targets = (() => { try { return (bridge.targets() || []).filter(kindOk); } catch { return []; } })();
      const h = validTarget(host, targets) ? host : (targets[0] && targets[0].host);
      if (!h) throw new Error('this app is not connected to a mineral');
      if (isLocalHost(h, targets)) throw new Error('connections need a server; this brain lives on this computer');
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
        const targets = (() => { try { return (bridge.targets() || []).filter(kindOk); } catch { return []; } })();
        const h = validTarget(host, targets) ? host : (targets[0] && targets[0].host);
        if (!h) throw new Error('this app is not connected to a mineral');
        if (isLocalHost(h, targets)) throw new Error('connections need a server; this brain lives on this computer');
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
    // through the central directory + crads account system, both deleted
    // (crads-account.mjs and device-enrol.mjs are gone from the tree). The 410s
    // stay as honest tombstones so an old page gets an answer, not a hang.
    if (req.method === 'GET' && path === '/account/devices') {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, retired: true, reason: 'the central account service has been retired; add this computer from one that already opens the mineral (Map page)' }));
      return;
    }
    if (req.method === 'POST' && path === '/account/enrol-device') {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, retired: true, reason: 'the central account service has been retired; add this computer from one that already opens the mineral (Map page)' }));
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/panel.html')) {
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
      // The edition stamp is gone (face collapse, 2026-09-01): the shell has
      // one face and ships unstamped.
      res.end(String(html()));
      return;
    }

    // E6.1: the minimum console (org seat). Same process, same auth context as
    // the panel; the page is read-only except answering requests (console-answer,
    // admin-gated at the verb). Served only for the org edition: the member
    // console seat is the member app's (plan E6, remaining).
    // The standalone member console retired with the face collapse
    // (2026-09-01): the seat tab of the one app shell is the console. An old
    // bookmark lands there rather than on a dead page. (member-console.html is
    // removed from the tree by a sibling pass; this route stopped serving it.)
    if (req.method === 'GET' && path === '/console') {
      res.writeHead(302, { location: '/#seat' }); res.end(); return;
    }

    // The topology sandbox page is DELETED (2026-09-01, one-face wave): the
    // reference diagram showed the hosted pricing model's worked examples, and
    // the Map section inside the shell draws the member's real world from
    // POST /topology/world below. No GET /topology remains to serve.

    // Verb-interview ruling 2026-08-03: a rock can birth a member their own
    // community ("rock for a member"). Rides the creator-door concierge rails:
    // this route FORCES the rock shape server-side and relays to the directory,
    // so the app cannot post arbitrary create-requests through it. Org edition
    // + Admin only. Honest-fails when the funnel is not live: the worker
    // answers a plain-words error, or 502 here when unreachable.
    // /rock-request (the New-Rock concierge) DIED 2026-08-09 (second loop):
    // rocks can't create rocks (mountain-model ladder rule). New rocks are
    // born at the sign-up door, by the person who will own them.
    // GET /wizard is GONE (2026-09-01): the org setup wizard was deleted with
    // the hosted create flow; the door's own self-host flow is the create path.


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
        try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end('host must be a configured target'); return;
        }
        // A brain folder has no terminal transport and needs none: the
        // member's own terminal is right there. Refused in words, before the
        // tty check, so the answer is the same on a build that has a tty.
        if (isLocalHost(host, targets)) { res.writeHead(500); res.end('this brain lives on this computer, so there is no server terminal to open. Open the folder in Claude Code instead (Help has the path).'); return; }
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

    // Stop hosting (the face collapse's rework of the retire-this-rock flow,
    // 2026-09-01): a mineral upgraded in place to host reverses that upgrade,
    // mineral-locally. The server re-verifies every guardrail independently of
    // the UI: Admin role, the exact arming phrase, and a live registry read
    // proving no member row remains. Nothing is destroyed. (/org-teardown, the
    // hosted era's whole-rock deletion with re-pasted cloud codes, is gone:
    // a self-hosted server is deleted where it lives, at the hosting provider.)
// GET /go/connect is GONE (2026-09-01): the invite page it routed to left
    // with the invitation system, and no page links the hop any more (backup
    // moved in-app 2026-08-05; the door's invite card died in the third pass).
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
      try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ targets, role, roleAssumed,
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
    if (path.startsWith('/own-brain/') && ownBrainRoute(req, res, path)) return;
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

    if (req.method === 'GET' && path === '/brain-download') {
      (async () => {
        const want = String(url.searchParams.get('box') || '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
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
    if (req.method === 'POST' && path === '/retrust') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
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
    if (req.method === 'POST' && (path.startsWith('/vault/') || path === '/devices/self-heal')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 3e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end('host must be a configured <slug>-box (or legacy <org>-rock) target'); return;
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

        const host = String(form.host ?? '');
        let targets = [];
        try { targets = (bridge.targets() || []).filter(kindOk); } catch { targets = []; }
        // the table is the target's (a folder serves LOCAL_VERBS), so a verb
        // outside it is "unknown" on that host, exactly like an org verb
        const spec = verbsFor(host, targets)[form.verb];
        if (!spec) { res.writeHead(400); res.end(`unknown verb: ${String(form.verb).slice(0, 60)}`); return; }
        if (spec.adminOnly && role === 'support') {
          res.writeHead(403); res.end(`this action needs an Admin login: you are signed in as Support (verb ${form.verb} is admin-only)`); return;
        }
        if (!validTarget(host, targets)) {
          res.writeHead(400); res.end('host must be a configured <slug>-box (or legacy <org>-rock) target'); return;
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
  return server;
}
