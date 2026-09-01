#!/usr/bin/env node
// box-cockpit.mjs — the PEBBLE cockpit data generator (a simpler, per-pebble version of the
// operator cockpit; reusable for EVERY pebble box). Reads ONE box and writes <box>/cockpit/data.json
// (status cards + a brain graph of wiki pages + [[links]]). Derives PURELY from the box's own data —
// no operator/cross-pebble content, no oracle. The cockpit HTML polls this file so it grows live as
// onboarding fills the brain in.
//
//   node box-cockpit.mjs <boxDir>
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readClaudeCredential } from '../lib/claude-credential.mjs';
import { lastOkRunBySkill } from '../lib/run-ledger.mjs';
import { connectionLabel } from '../lib/connection-labels.mjs';
import { resolveBrainRoot, isOrgBox, readOwnership } from '../lib/brain-root.mjs';

const box = path.resolve(process.argv[2] || '.');
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const rdJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const yget = (yaml, key) => { const m = (yaml || '').match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`)); return m ? m[1].trim() : null; };

// ---- org mode (2026-08-09, unification stage S3) ----
// The same builder serves BOTH faces. A rock's brain lives at its resolved
// brain_root (deployment.yaml, default <box>/brain) and is recognised by
// org-policy.yaml at that root — the same detection the panel's verbs use.
// In org mode the identity fields read the org policy, onboarding reads the
// BRAIN's state file, and the wiki walk keeps to the wiki proper (root pages
// + notes/ decisions/ insights/), exactly the brain-list scope, so machinery
// dirs (registry/, control/, factory/, ...) never become graph nodes.
// A MEMBER-BORN BOX'S BRAIN IS THE BOX ITSELF (finding 107's fifth reader —
// this file — was the one that finally forced the extraction). The full
// chain, member-born leg included, lives in engine/lib/brain-root.mjs; a
// plain pebble is untouched because no org-policy.yaml sits at its box root.
const brainRoot = resolveBrainRoot(box);
const orgPolicy = rd(path.join(brainRoot, 'org-policy.yaml'));
// A member-born rock has NO org-policy.yaml by design (the 2026-08-17
// self-registration flow writes only ownership.json at the flip), so a
// policy-only test left every promoted rock building its graph in pebble
// mode: unprefixed node paths against org verbs rooted at the box itself,
// and the app's two panes could not agree. isOrgBox carries both legs.
const IS_ORG = isOrgBox(box);
const ownership = readOwnership(box);
// anchored key match (^\s*key:) so oget('name') can never land on display_name
const oget = (key) => { const m = (orgPolicy || '').match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, 'm')); return m ? m[1].trim() : null; };

const profile = IS_ORG ? '' : (rd(path.join(box, 'profile.yaml')) || '');
const onb = rdJSON(path.join(IS_ORG ? brainRoot : box, 'onboarding-state.json'));
const mcp = rdJSON(path.join(box, '.mcp.json'));

// ---- onboarding progress (grows per answer) ----
// /onboard moved from 11 modules to the 8 layers (engine/skills/onboard.md: "no
// separate modules; the 8 layers carry everything the old 11 modules did"), so a
// brain written today carries `layers` + `current_layer` while one written before
// carries `modules` + `current_module`. Read whichever is present.
//
// Read it DEFENSIVELY, and not merely for tidiness: this file also builds the brain
// graph below, so an unguarded throw up here takes the graph down with it, the
// caller's `|| true` swallows the error, and the panel then serves the last good
// data.json forever while looking healthy. That is exactly what happened when the
// layers rename landed: every box on the new schema died at `Object.entries(undefined)`
// and showed a graph frozen at whatever the wiki held when onboarding started.
const steps = Object.entries(onb?.layers || onb?.modules || {}).map(([name, m]) => ({
  name, status: m?.status || 'not-started', raw: (m?.raw || []).length, synthesized: !!m?.synthesized,
}));
// The two schemas spell completion differently ('covered' in the interview loop,
// 'done' in the synthesised/ingested state), so count both.
const covered = steps.filter((m) => m.status === 'covered' || m.status === 'done').length;
const current = onb?.current_layer || onb?.current_module
  || (steps.find((m) => m.status === 'in-progress')?.name) || (steps[0]?.name);

// ---- brain graph: wiki pages = nodes, [[links]] = edges ----
// Node ids are wiki-relative paths (sans .md) so same-named files in different folders
// can't collide; `label`/`group` keep the shape the code-server cockpit HTML renders,
// while `title`/`type`/`path`/`desc`/`deg` feed the member app's full graph viewer.
const wikiDir = IS_ORG ? brainRoot : path.join(box, 'wiki');
// the org wiki proper, brain-list's scope: root pages + these three dirs;
// everything else at the root of a rock brain is machinery, not pages
const ORG_WIKI_DIRS = new Set(['notes', 'decisions', 'insights']);
const pages = [];
const seen = new Set();
// `prefix` is where this walk's root sits RELATIVE TO WHERE brain-read cd's
// (the brain root on a rock, /state/wiki on a pebble). `rel` stays the walk-root
// -relative id — that parity is load-bearing (see below) — but the READ path the
// app hands back to brain-read must include the prefix, or every page found by
// a prefixed walk renders in the graph and refuses to open. Hit live 2026-08-17:
// a rock's graph showed _layers/5-past.md, brain-read answered "no such page",
// because the file is wiki/_layers/5-past.md from where brain-read stands.
// Finding 107's fourth reader: same wiki, graph id and read path disagreeing.
const walk = (dir, rel, orgRoot = false, prefix = '') => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) {
  if (e.isDirectory()) {
    if (e.name === '.git') continue;
    if (orgRoot && rel === '' && !ORG_WIKI_DIRS.has(e.name)) continue;
    walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, orgRoot, prefix);
  }
  else if (e.name.endsWith('.md')) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (seen.has(r)) continue;          // first walk wins; ids are rel paths and must stay unique
    seen.add(r);
    pages.push({ rel: r, file: path.join(dir, e.name), read: prefix ? `${prefix}/${r}` : r });
  }
} };
walk(wikiDir, '', IS_ORG);
// A rock's PAGES live under <brain_root>/wiki, and until 2026-08-11 nothing walked
// it: the org scope kept root .md plus the three dirs above, while /onboard writes
// every layer to wiki/_layers/<n>-<name>.md and every person to wiki/people/*.md in
// BOTH scopes (engine/skills/onboard.md). A fully onboarded rock therefore reported
// `pages: 3` — CLAUDE.md, README.md, notes/README.md — with its eight layer pages,
// its people and every [[wikilink]] between them invisible, next to a step counter
// reading 8 of 8 off a different file. Sam's ruling: one layout across both scopes,
// so the cockpit moves rather than the skill.
//
// Walked as its own ROOT, not as another org dir, and that is the load-bearing part:
// `folder` is the first path segment, so walking it from brainRoot would file people
// under `wiki` and peopleCount would stay 0. Relative to <brain_root>/wiki, a rock's
// `people/harriet.md` gets exactly the id a pebble's does.
if (IS_ORG) walk(path.join(brainRoot, 'wiki'), '', false, 'wiki');
// "No pages yet" is a TRUE sentence about an empty brain and a LIE about a wiki
// root that isn't there, and the two render identically (walk() returns quietly
// on a missing dir). Sam hit the lie on 2026-08-10: a rock born hours before org
// mode shipped ran the old builder, which looked for <box>/wiki on a box whose
// brain is at brain_root, found nothing, and the panel said the brain was empty
// while the Files tree beside it listed the pages. Carry the root out with the
// count so the empty state can tell the two apart.
const rootMissing = !existsSync(wikiDir);
const SKELETON = new Set(['daily-brief', 'log', 'priorities']);   // scaffold pages, dimmed until real
const TYPE_BY_FOLDER = { people: 'person', projects: 'project', _layers: 'layer' };
for (const p of pages) {
  p.id = p.rel.replace(/\.md$/, '');
  p.slug = p.id.split('/').pop();
  p.folder = p.rel.includes('/') ? p.rel.split('/')[0] : 'core';
  p.body = rd(p.file) || '';
  p.title = (p.body.match(/^#\s+(.+?)\s*$/m) || [])[1] || p.slug.replace(/-/g, ' ');
  p.type = SKELETON.has(p.slug) ? 'scaffold' : (TYPE_BY_FOLDER[p.folder] || (p.folder === 'core' ? 'note' : p.folder.replace(/s$/, '')));
  const fmDesc = (p.body.match(/^description:\s*"?([^"\n]+)"?/m) || [])[1];
  const firstLine = p.body.split('\n').find((l) => l.trim() && !/^(#|---|[a-z-]+:|\s*[-*]\s*$)/.test(l.trim()));
  p.desc = (fmDesc || firstLine || '').trim().slice(0, 160);
}
// Link resolution (2026-07-30). Two silent losses, both found by driving a brain that
// contains the shapes a real wiki does:
//
//   CASE. Obsidian resolves [[Harriet]] to harriet.md; this map was keyed on the exact
//   slug, so every capitalised wikilink in a brain produced NO edge at all. On a test
//   brain, [[Harriet]], [[HARRIET]] and [[Three-Day-Week]] each silently vanished. Keys
//   are lowercased now, so a link resolves the way the person writing it expects.
//
//   AMBIGUITY. A bare Map keyed on basename means the LAST page walked wins, so with
//   people/notes.md and projects/notes.md both present, every [[notes]] in the brain
//   pointed at whichever the directory walk happened to reach second. A path-qualified
//   link ([[people/notes]]) now matches on the path, and a bare ambiguous one resolves
//   deterministically (shallowest, then alphabetical) instead of by walk order.
const byKey = new Map();      // lowercased basename -> [pages], first-listed is the pick
for (const p of pages) {
  const k = p.slug.toLowerCase();
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(p);
}
for (const arr of byKey.values()) {
  arr.sort((a, b) => (a.rel.split('/').length - b.rel.split('/').length) || a.rel.localeCompare(b.rel));
}
const byPath = new Map(pages.map((p) => [p.id.toLowerCase(), p]));
// A wikilink target as written: may carry folders ([[people/harriet]]), and may be in any
// case. Prefer an exact path match so a qualified link is never ambiguous; fall back to
// the basename pick.
const resolveLink = (raw) => {
  const t = String(raw).trim().replace(/\.md$/i, '');
  if (!t) return null;
  const exact = byPath.get(t.toLowerCase());
  if (exact) return exact;
  const cands = byKey.get(t.split('/').pop().toLowerCase());
  return cands ? cands[0] : null;
};
const linkMap = new Map();   // undirected, de-duplicated, weighted; keeps first typed rel seen
const addLink = (a, b, rel) => {
  if (a === b) return;
  const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
  const cur = linkMap.get(key);
  if (cur) { cur.w++; if (rel && !cur.rel) cur.rel = rel; }
  else linkMap.set(key, { source: a, target: b, w: 1, ...(rel ? { rel } : {}) });
};
// ONE pass over the wikilinks, not two. Two passes double-counted every typed
// relation: `- works-with :: [[retreat]]` was picked up by the typed scanner AND by
// the plain one, so a page referencing another twice reported a weight of three
// (caught by box-cockpit-graph.test.mjs, 2026-07-30). Weight drives how heavy an
// edge and how large a node draws, so an inflated one is a picture of a brain that is
// more connected than it is. Each link is now classified by looking back to the start
// of its own line: a `rel ::` immediately before it makes it typed, otherwise plain.
for (const p of pages) {
  for (const m of p.body.matchAll(/\[\[([^\]|#]+)/g)) {
    const t = resolveLink(m[1]);
    if (!t) continue;
    const lineStart = p.body.lastIndexOf('\n', m.index) + 1;
    const before = p.body.slice(lineStart, m.index);
    const typed = before.match(/^\s*(?:[-*]\s*)?([a-z][a-z-]+)\s*::\s*$/);
    addLink(p.id, t.id, typed ? typed[1] : undefined);
  }
}
const links = [...linkMap.values()];
const degOf = new Map();
for (const l of links) { degOf.set(l.source, (degOf.get(l.source) || 0) + 1); degOf.set(l.target, (degOf.get(l.target) || 0) + 1); }
const nodes = pages.map((p) => ({
  id: p.id, label: p.slug.replace(/-/g, ' '),
  group: SKELETON.has(p.slug) ? 'skeleton' : (p.folder === 'people' ? 'people' : 'core'),
  // `path` is the READ path (brain-read resolvable), not the id: on a rock the
  // wiki/ walk's pages live at wiki/<rel> from where brain-read stands.
  title: p.title, type: p.type, path: p.read || p.rel, desc: p.desc, deg: degOf.get(p.id) || 0,
}));
const peopleCount = pages.filter((p) => p.folder === 'people').length;
const realPages = pages.filter((p) => !SKELETON.has(p.slug)).length;

// ---- connections (configured / authed / pending) ----
// Three-layer v2 (2026-07-27): the member owns their tokens, so this view is how
// an expired/missing credential becomes VISIBLE instead of silently breaking
// skills. Checks are honest and cheap: placeholder commands and unresolved
// ${VAR} credential refs are knowable from the box alone; a live OAuth probe is
// not, so a fully-wired server reports "configured" rather than claiming auth.
// ONE READER FOR THE SIGN-IN, AND IT ONLY CLAIMS PRESENCE (2026-08-20 audit).
// This was `!!rd(<box>/.claude-auth/.credentials.json)`, a third spelling of the
// same test that engine/heartbeat.mjs and engine/ops/box-account.mjs each spelled
// their own way, and the row below turned it into the words "signed in as
// <email>". A revoked or unrefreshable grant leaves that file exactly where it
// was, so the row said "signed in" about a mineral whose every scheduled job was
// failing. The shared reader is honest about being a presence test; the row is
// where this file gets honest about what presence is worth.
const claude = readClaudeCredential(box);
const claudeAuthed = claude.present;
// WHICH account, not just whether. Two different things are called "signed in" and
// conflating them cost a real debugging session: connecting the Claude Code desktop
// app is your laptop reaching the mineral over SSH, on the LAPTOP's account, and it
// leaves this directory empty. THIS is the mineral's own Claude Code holding its own
// credentials, which is what lets it run /onboard and the cadence jobs with nobody at
// the keyboard. Only an interactive sign-in ON the mineral (the app's Terminal tab, or
// `claude` in any shell there) writes it. Naming the account also makes a box on the wrong
// account visible at a glance, which now matters more: box-up.sh no longer refuses
// to start on the operator account (it used to, and bricked the box doing it), so
// this row is where a wrong account gets noticed instead.
const claudeEmail = claude.account;
// THE ONLY LOCAL EVIDENCE THAT THE SIGN-IN STILL WORKS: a scheduled run that
// FINISHED. The kernel writes ok or fail per run into the run ledger, and
// lastOkRunBySkill reads the rotation-proof side map, so this survives the
// machinery flood that evicts skill rows inside a day. A mineral whose grant was
// revoked keeps its credential file and keeps firing on cadence; what stops is
// work completing, and that is the thing worth putting next to the sign-in.
const lastSkillOk = (() => {
  let newest = null;
  for (const r of Object.values(lastOkRunBySkill(box))) {
    if (!newest || String(r.ts) > String(newest)) newest = r.ts;
  }
  return newest;
})();
// Plain words, and no verdict: a mineral nobody has scheduled anything on yet is
// not broken, it is new. State stays 'ok' on presence alone for the same reason,
// because the app gates the Cadence Save button on this row and locking a member
// out of their own schedule over an unproven grant would be the worse lie.
const sinceOk = (() => {
  if (!lastSkillOk) return ' · no scheduled run has finished on it yet';
  const mins = Math.round((Date.now() - new Date(lastSkillOk).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  const ago = mins < 90 ? `${mins}m` : (mins < 60 * 36 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`);
  return ` · last scheduled run finished ${ago} ago`;
})();
const tgToken = (rd(path.join(box, 'secrets', 'telegram_bot_token')) || '').trim();
const tgLive = tgToken && !/PASTE|REPLACE|TEST-/.test(tgToken);
// Cadence liveness: the in-container scheduler (which replaced system cron)
// emits heartbeat-full.json hourly — a fresh file proves the schedule engine is
// alive. The old `crontab -l` check tested a path that no longer exists.
let cadenceAlive = false;
try { cadenceAlive = (Date.now() - statSync(path.join(box, 'cockpit', 'heartbeat-full.json')).mtimeMs) < 75 * 60 * 1000; } catch {}
// TWO DIFFERENT WORLDS, and saying "not configured" for both was the bug (2026-08-05).
// `.mcp.json` is what a SCHEDULED JOB loads: the kernel runs `claude -p` with cwd
// = the state dir, so those servers are the box's own, usable while the member is
// asleep. The connectors a member adds in the Claude Code app belong to their
// CLAUDE ACCOUNT and reach interactive sessions only. Verified rather than
// assumed: a headless run lists the .mcp.json servers and none of the account
// connectors, and cadence jobs are headless by construction.
//
// A member who has connected Gmail in the app and reads "not configured" here
// concludes the panel is broken. It is not, but the honest answer is the middle
// state, which did not exist: works for you, not for your box on its own.
// CACHED, because `claude mcp list` health-checks every server over the network
// and this builder runs on every dashboard refresh. Only boxes with no .mcp.json
// reach it at all, which is precisely the boxes that would pay the latency on
// every load. Ten minutes is far shorter than the time it takes a member to go
// and connect something, and a stale-by-minutes answer here costs nothing.
const CONN_CACHE = path.join(box, 'cockpit', 'connectors.json');
function accountConnectors() {
  try {
    const c = JSON.parse(readFileSync(CONN_CACHE, 'utf8'));
    if (Date.now() - c.at < 10 * 60 * 1000) return c.names || [];
  } catch { /* no cache yet, or unreadable: ask the CLI */ }
  const names = probeConnectors();
  try {
    mkdirSync(path.dirname(CONN_CACHE), { recursive: true });
    writeFileSync(CONN_CACHE, JSON.stringify({ at: Date.now(), names }));
  } catch { /* cache is an optimisation, never a requirement */ }
  return names;
}
function probeConnectors() {
  // OPT-IN, and not merely for tidiness. `claude mcp list` health-checks every
  // configured server, which STARTS each stdio one (npx playwright, uv, node
  // bridges). Ambient, this builder would do that anywhere a `claude` binary
  // happens to be on PATH: it made unrelated, timing-sensitive tests fail across
  // a parallel suite the first time it shipped. The box's own dashboard verb sets
  // the flag; nothing else pays for a question it never asked.
  if (process.env.AIOS_CONNECTOR_PROBE !== '1') return [];
  try {
    const out = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(box, '.claude-auth') },
    });
    return out.split('\n')
      // only a HEALTHY connector counts; "! Needs authentication" is a broken one,
      // and reporting it as a connection is the same class of lie in miniature.
      // EVERY healthy connector is kept (2026-08-09 audit, R8): the Connections
      // page reads this cache to show account connectors honestly, so the old
      // mail/calendar filter moved to the one place that wants only mail.
      .filter((l) => /Connected/.test(l) && !/Needs authentication|Failed/.test(l))
      // A SERVER NAME CAN CONTAIN COLONS (finding 106, 2026-08-13). `split(':')[0]`
      // assumed it could not, so the plugin-provided server `plugin:gsd:gsd`
      // entered this cache as the bare word "plugin" and the Connections page
      // rendered THAT as a connection's display name — the raw-identifier-on-the-
      // surface class Sam ruled on in the 2026-08-09 audit ("one connection-label
      // source kills the raw lowercase names"). The real separator is colon-SPACE:
      // the name may hold colons and so may the URL after it, but neither holds ": ".
      .map((l) => { const i = l.indexOf(': '); return (i < 0 ? l : l.slice(0, i)).trim(); })
      // A PLUGIN SERVER IS NOT AN ACCOUNT CONNECTOR (same finding). Every name in
      // this cache is described downstream as "connected to your Claude account in
      // the app" and "in your chats only — account connectors can never run in
      // scheduled jobs". Both are false of a plugin-provided stdio server: it is
      // configured on THIS box and it runs wherever `claude` runs, jobs included.
      // Listing it here stated two wrong things about it at once.
      .filter((n) => n && !/^plugin:/i.test(n));
  } catch { return []; }   // no CLI, no account, no network: just don't claim anything
}

// Names come from the shared label module: this file once carried its own
// 3-entry map and every other server rendered as its raw lowercase key on the
// Overview card (2026-08-09 audit finding).
const servers = mcp?.mcpServers ? Object.keys(mcp.mcpServers) : [];
const provider = yget(profile, 'provider') || (servers.includes('ms365') ? 'microsoft' : servers.includes('google') ? 'google' : null);
const serverConn = (s) => {
  const def = mcp.mcpServers[s] || {};
  const name = connectionLabel(s);
  if (/^REPLACE-with/.test(String(def.command || ''))) return { name, status: 'not wired yet', state: 'pending' };
  const missing = [...JSON.stringify(def).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((v) => !process.env[v]);
  if (missing.length) return { name, status: `credential not set (${missing.join(', ')})`, state: 'pending' };
  return { name, status: 'configured', state: 'configured' };
};
// Called unconditionally (not only on unconfigured boxes) so the cache the
// Connections page reads stays warm once servers exist; the probe itself is
// still opt-in + 10-minute cached. The mail filter lives here now, at the one
// use that wants only mail.
const inApp = accountConnectors();
const mailish = inApp.filter((n) => /gmail|mail|calendar|outlook/i.test(n));
const connections = [
  // The row says WHERE the fix is, because the wrong answer is the intuitive one:
  // a member reads "not signed in" and connects the desktop app, which cannot fix it.
  { name: 'Claude sign-in on this mineral', state: claudeAuthed ? 'ok' : 'pending',
    status: claudeAuthed ? ('signed in' + (claudeEmail ? ' as ' + claudeEmail : '') + sinceOk)
                         : 'not signed in yet · sign in from the Terminal tab' },
  ...(servers.length ? servers.map(serverConn) : [
    mailish.length
      ? { name: 'Email + Calendar', status: 'in your chats only, not in scheduled jobs', state: 'pending' }
      : { name: 'Email + Calendar', status: 'not configured', state: 'pending' }]),
  { name: 'Telegram', status: tgLive ? 'linked' : 'ready to link', state: tgLive ? 'ok' : 'configured' },
  { name: 'Cadence (daily/weekly jobs)', status: cadenceAlive ? 'running' : 'staged · starts after setup', state: cadenceAlive ? 'ok' : 'configured' },
];

const phase = onb?.phase || 'interview';
const stageLabel = phase === 'done' ? 'live' : `onboarding · ${current || 'getting started'}`;
// installed skills, both faces: the Overview's Skills card reads this count
// instead of scraping it out of status text (2026-08-09 audit freebie)
const skillsInstalled = (() => {
  try {
    const d = path.join(box, '.claude', 'skills');
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(d, e.name, 'SKILL.md'))).length;
  } catch { return 0; }
})();
const data = {
  // On a member-born rock every oget() is null (no policy file), and
  // basename(brainRoot) would introduce the rock as "state": fall back to the
  // box's own name, then the org handle the flip recorded in ownership.json.
  pebble: IS_ORG
    ? (oget('display_name') || oget('name') || (rd(path.join(box, 'box-name')) || '').trim().slice(0, 60)
       || ownership?.owner_slug || path.basename(brainRoot))
    : yget(profile, 'user_short') || yget(profile, 'user_name') || path.basename(box),
  // One name (2026-08-09, extended to rocks 2026-08-14 — see docs/naming.md).
  // The box name IS the assistant's name. box-name is the mirror file
  // box-rename writes; reading it first converges displays on a box whose boot
  // has not yet run the one-time profile migration.
  //
  // A ROCK reads display_name, not persona. It used to lead with `persona`,
  // which is how a rock its owner had named "QA Run Two Gmail" introduced
  // itself on its own Overview as "Foreman" — the hardcoded build-time default
  // nobody was ever asked for. The rock's assistant is called what the rock is
  // called; persona survives in org-policy.yaml only as a derived mirror.
  assistant: IS_ORG
    ? (oget('display_name') || oget('name') || oget('persona')
       || (rd(path.join(box, 'box-name')) || '').trim().slice(0, 60) || ownership?.owner_slug || 'your rock')
    : (rd(path.join(box, 'box-name')) || '').trim().slice(0, 60) || yget(profile, 'assistant_name') || 'your assistant',
  business: IS_ORG ? null : (profile.match(/business:[\s\S]*?customers:\s*"([^"]+)"/) || [])[1] || null,
  tier: IS_ORG ? 'rock' : 'pebble',
  provider, generated_at: new Date().toISOString(),
  stage: stageLabel, phase,
  // `modules` is the WIRE name (engine/cockpit/box-cockpit.html reads it); the
  // source field is `layers` on any brain onboarded since the 8-layer rewrite.
  // 8 is the floor for a brain with no state file yet, not the old 11.
  onboarding: { phase, covered, total: steps.length || 8, current, modules: steps },
  brain: { pages: realPages, skeleton: pages.length - realPages, people: peopleCount, root: wikiDir, root_missing: rootMissing },
  skills: { installed: skillsInstalled },
  // Health here describes the BOX, never the engagement. state-view's
  // engagement_health used to ride this field and made the verdict depend on
  // whether state-view.json happened to exist: a rock got a permanent false
  // Amber (its state-view could not see brain/onboarding-state.json — finding
  // 194), and a mid-onboarding pebble read "Mostly working / keeps retrying"
  // with a state-view but "All good" without one, for the same real state.
  // For a pebble the projection only ever encoded onboarding-done anyway,
  // which `phase` already is. Both panel tokens are in the healthy set.
  health: phase === 'done' ? 'active' : 'onboarding',
  connections,
  graph: { nodes, links },
};
mkdirSync(path.join(box, 'cockpit'), { recursive: true });
writeFileSync(path.join(box, 'cockpit', 'data.json'), JSON.stringify(data, null, 2) + '\n');
if (process.argv.includes('--print')) console.log(JSON.stringify(data, null, 2));
else console.log(`cockpit data: ${realPages} brain pages, ${links.length} links, onboarding ${covered}/${data.onboarding.total}`);
