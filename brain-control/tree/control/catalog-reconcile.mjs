#!/usr/bin/env node
// catalog-reconcile.mjs — materialise each active member's ENTITLED view of the
// skills library into their inbox repo (inbox-<slug>/catalog/catalog.json).
// Spec: ai-os docs/superpowers/specs/2026-08-04-skills-cadence-library-design.md § 7.1.
//
// Entitlement is enforced here at the source: a member's box never even
// receives metadata for content they cannot see. Transport is the existing
// push-down (so the active / delivery-pause / consent gates all apply), and a
// local render cache skips the push when nothing changed, so the inbox does
// not grow a commit per reconcile tick. Runs inside reconcile-all; fail-soft.
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy, renderCatalog, enforceCategories, CATEGORIES } from './catalog-lib.mjs';
import { normalizeRow, extractRow } from '../registry/normalize-row.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const y = (text, k) => ((text.match(new RegExp(`^${k}:\\s*"?([^"\n#]*)"?`, 'm')) || [])[1] || '').trim();

// The four item-library roots, siblings of skills-library (step 2,
// spec 2026-08-26-delivery-model). Each item is <root>/<id>/, named by a
// manifest and proven real by a payload marker. skills-library is the one
// exception: it keeps its exact current behaviour (no marker property below),
// because existing skills-library items were never required to carry
// SKILL.md to be catalogable, and changing that now would silently drop live
// entries. Packs are not one of these four roots; they keep their own branch
// further down, unchanged apart from gaining `title`.
const KINDS = {
  skill: { root: 'skills-library', manifest: 'skill.yaml' },
  prompt: { root: 'prompts-library', manifest: 'prompt.yaml', marker: 'PROMPT.md' },
  page: { root: 'pages-library', manifest: 'page.yaml', marker: 'page.html' },
  dir: { root: 'dirs-library', manifest: 'dir.yaml', marker: 'files', markerIsDir: true },
};

// Directory hint for the operator-facing refusal line in main() below. Packs
// live outside the KINDS table (in packs/), so this is the one place that
// still needs a manual add on top of KINDS when a new kind ever arrives.
const dirForKind = (kind) => (kind === 'pack' ? 'packs' : (KINDS[kind] || KINDS.skill).root);

// WHERE EACH KIND'S PAYLOAD LANDS (delivery-model, step 3, spec § "Destinations,
// and why each"). Every one of these is a member's INBOX sub-path, not a
// library root: KINDS.root above says where the rock authors an item;
// this says where a member's box receives it.
//
// skill -> offers is UNCHANGED FOREVER (see THE PACKAGES / OFFERS NOT SKILLS
// comment block further down, which this table must never contradict):
// panel-server.mjs reads exactly /state/org-inbox/offers/<id> on every
// shipped app, and every box in the field picks up a new image only when it
// restarts, so there is always a window of new rocks and old boxes. Moving
// this path breaks pickup on every one of them, forever, not just today.
//
// prompt -> prompts is read IN PLACE by engine/appshell/prompts-list.mjs on
// every shipped image already (ai-os), so this needs zero box change and
// zero app change to start working the moment this ships.
//
// dir -> offers-dirs and page -> offers-pages are NEW paths, on purpose, for
// the same reason offers/ exists instead of reusing skills/: no already-
// shipped box reads either folder yet (dir-install.mjs's second search root,
// and any page-side reader, are later ai-os steps), so staging into them
// costs nothing and makes the rollout order-independent.
//
// page is the one that matters most. Staging a page into the EXISTING
// `pages/` folder instead would make every already-deployed box auto-copy
// the rock's whole entitled page set into the member's nav on its very next
// 2-minute sync, because seed_pages() in engine/box/org-sync.sh reads
// exactly that folder and copies whatever it finds. That is the precise
// failure the skills/->offers/ split below was invented to prevent, now for
// pages instead of skills. NOTHING may ever be staged into `pages/` from
// this file.
const DEST = { skill: 'offers', prompt: 'prompts', dir: 'offers-dirs', page: 'offers-pages' };
// The full set of reconcile-owned destinations, in the exact spelling
// prune-down.mjs's allow-list expects. Every one of these gets a prune call
// every tick the member's entitled ids changed, whether or not that
// destination itself staged a payload this tick (delivery-model, step 4).
const RECONCILE_DESTS = Object.values(DEST);

// Every real file under dir, as { rel, abs } sorted by rel, so a hash built
// from the list is stable regardless of directory-walk order.
async function listPayloadFiles(dir) {
  let entries = [];
  try { entries = await readdir(dir, { recursive: true, withFileTypes: true }); } catch { return []; }
  const files = entries.filter((e) => e.isFile())
    .map((e) => { const abs = path.join(e.parentPath, e.name); return { rel: path.relative(dir, abs), abs }; });
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// Content hash of everything actually staged for one destination this tick:
// real bytes, never id/version metadata. The render cache used to be keyed
// on JSON.stringify(view.items) alone, which is pure metadata, so an author
// editing a PROMPT.md or a page.html body WITHOUT bumping `version` short-
// circuited the whole member and never restaged (delivery-model step 3
// requirement 4). Hashing what actually landed on disk closes that gap for
// every kind uniformly, not just the two the brief names.
async function hashPayload(dir) {
  const files = await listPayloadFiles(dir);
  const h = createHash('sha256');
  for (const { rel, abs } of files) {
    h.update(rel); h.update('\0');
    h.update(await readFile(abs));
    h.update('\0');
  }
  return h.digest('hex');
}

// Stage one entitled item's REAL payload into destDir, a per-destination temp
// root shared by every item of that kind this tick. Returns false when the
// payload marker is gone instead of throwing, so the caller can collect it
// and report it by name (requirement 3) instead of the old silent `continue`.
//
// readKind's own marker check (KINDS above) already keeps this from
// happening for prompt/page/dir at LIBRARY time: an item missing its marker
// never becomes a library entry at all, so it never reaches here. skill
// carries no marker check there, by design (existing skills-library items
// were never required to carry SKILL.md to be catalogable), so a skill.yaml
// with no SKILL.md reaches this function exactly as it reached the old
// inline check it replaces.
async function stageItem(item, destDir) {
  const spec = KINDS[item.kind];
  const srcDir = path.join(repoRoot, spec.root, item.id);
  if (item.kind === 'skill') {
    if (!existsSync(path.join(srcDir, 'SKILL.md'))) return false;
    await cp(srcDir, path.join(destDir, item.id), { recursive: true });
    return true;
  }
  if (item.kind === 'prompt') {
    const body = await readFile(path.join(srcDir, 'PROMPT.md')).catch(() => null);
    if (body === null) return false;
    // prompts/<id>/<id>.md: the id names both the "bucket" directory and the
    // stem, which is exactly what prompts-list.mjs (ai-os) already walks.
    await mkdir(path.join(destDir, item.id), { recursive: true });
    await writeFile(path.join(destDir, item.id, `${item.id}.md`), body);
    return true;
  }
  if (item.kind === 'page') {
    const body = await readFile(path.join(srcDir, 'page.html')).catch(() => null);
    if (body === null) return false;
    await writeFile(path.join(destDir, `${item.id}.html`), body);
    // seed-org-pages.mjs (ai-os) already reads exactly this shape for a
    // title: JSON.parse(readFileSync(id + '.json')).title.
    await writeFile(path.join(destDir, `${item.id}.json`), JSON.stringify({ title: item.title || '' }) + '\n');
    return true;
  }
  if (item.kind === 'dir') {
    const filesDir = path.join(srcDir, 'files');
    const st = await stat(filesDir).catch(() => null);
    if (!st || !st.isDirectory()) return false;
    const yaml = await readFile(path.join(srcDir, 'dir.yaml')).catch(() => null);
    if (yaml === null) return false;
    await cp(filesDir, path.join(destDir, item.id), { recursive: true });
    // dir-install.mjs (ai-os) greps exactly this sidecar's `kind:` line; we
    // never parse or rewrite it, only carry it through byte-for-byte.
    await writeFile(path.join(destDir, `${item.id}.yaml`), yaml);
    return true;
  }
  return false;
}

// One entry per <kind-root>/<id>/ manifest that also has its payload marker
// present (skill: no marker check, see KINDS above). Manifest fields are the
// same set skill.yaml already used, so the existing scalar getter y() reads
// all four kinds unchanged: id (the directory name), version, title,
// description, category, gate.
async function readKind(root, kind) {
  const spec = KINDS[kind];
  const out = [];
  for (const d of (await readdir(path.join(root, spec.root)).catch(() => []))) {
    if (d.startsWith('_')) continue;
    const manifest = await readFile(path.join(root, spec.root, d, spec.manifest), 'utf8').catch(() => null);
    if (!manifest) continue;
    if (spec.marker) {
      const markerPath = path.join(root, spec.root, d, spec.marker);
      if (spec.markerIsDir) {
        const st = await stat(markerPath).catch(() => null);
        if (!st || !st.isDirectory()) continue;
      } else if (!existsSync(markerPath)) continue;
    }
    const entry = {
      id: d, kind,
      version: parseInt(y(manifest, 'version'), 10) || 0,
      title: y(manifest, 'title'),
      description: y(manifest, 'description'),
      category: y(manifest, 'category'),   // raw truth; R7 enforcement happens at publish (enforceCategories)
      gate: y(manifest, 'gate'),
    };
    if (kind === 'skill') entry.outbound = /^outbound:\s*true/m.test(manifest);
    out.push(entry);
  }
  return out;
}

// The library: one entry per <kind-root>/<id>/ manifest (skill, prompt, page,
// dir), plus one per packs/<id>/ pack.yaml (v2). Packs carry fee + a contents
// summary so the member side can render what ships and detect when it has
// all landed.
export async function readLibrary(root = repoRoot) {
  const lib = [];
  for (const kind of Object.keys(KINDS)) lib.push(...(await readKind(root, kind)));

  const flow = (m, k) => {
    const x = m.match(new RegExp(`^\\s+${k}:\\s*\\[([^\\]]*)\\]`, 'm'));
    return x ? x[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
  };
  for (const d of (await readdir(path.join(root, 'packs')).catch(() => []))) {
    if (d.startsWith('_')) continue;
    const manifest = await readFile(path.join(root, 'packs', d, 'pack.yaml'), 'utf8').catch(() => null);
    if (!manifest) continue;
    if (!/^\s+skills:\s*\[|^\s+context:\s*\[|^\s+prompts:\s*\[|^\s+pages:\s*\[|^\s+dirs:\s*\[/m.test(manifest)) continue;   // v1 pack: not catalogable
    lib.push({
      id: d, kind: 'pack',
      version: parseInt(y(manifest, 'version'), 10) || 0,
      title: y(manifest, 'title'),
      description: y(manifest, 'summary') || y(manifest, 'title'),
      category: y(manifest, 'category'),   // raw truth; R7 enforcement happens at publish (enforceCategories)
      gate: y(manifest, 'gate'),
      fee: Number(y(manifest, 'fee')) || 0,
      contents: {
        skills: flow(manifest, 'skills'),
        files: flow(manifest, 'context').length + flow(manifest, 'prompts').length,
        pages: flow(manifest, 'pages'),    // ids, not a count: the member UI installs by id
        dirs: flow(manifest, 'dirs'),      // ids, not a count: the member UI installs by id
        // Raw entries, kept alongside the `files` count above (delivery-model
        // step 6): contents.prompts/context are id-first-path-second, so
        // renderCatalog needs the actual entries, not just how many there
        // are, to tell a real library id from a pack-relative path. `files`
        // itself is untouched -- pack-pages-contents.test.mjs pins it as a
        // genuine count.
        prompts: flow(manifest, 'prompts'),
        context: flow(manifest, 'context'),
      },
    });
  }
  return lib;
}

async function main() {
  const policyRaw = await readFile(path.join(repoRoot, 'catalog', 'policy.json'), 'utf8').catch(() => null);
  if (policyRaw === null) { console.log('catalog-reconcile: no catalog/policy.json — nothing is published.'); return; }
  const policy = parsePolicy(policyRaw);
  const { library, refused } = enforceCategories(await readLibrary());

  let anchorSlug = '';
  try {
    const pol = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8');
    anchorSlug = (pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || '';
  } catch {}

  const cacheDir = path.join(repoRoot, 'state', 'catalog-rendered');
  await mkdir(cacheDir, { recursive: true });

  // R7 (ai-os spec 2026-08-09-pebble-dashboard-audit.md): an unknown category
  // is REFUSED by name at materialisation, never silently bucketed as "other"
  // in members' catalogs. A duplicate id across kinds (enforceCategories,
  // catalog-lib.mjs) is refused through the same channel with its own `why`,
  // so the category wording below stays byte-identical for a category
  // refusal. The refusal is in this log on every tick; the rock's notices get
  // it once per change (a standing misconfiguration must not flood
  // notices.json out of its bounded window on a cron).
  for (const r of refused) {
    const reason = r.why || `category "${r.category}" is not one of ${CATEGORIES.join('|')}`;
    console.log(`catalog-reconcile: REFUSED: ${r.id}: ${reason}. `
      + `Fix ${dirForKind(r.kind)}/${r.id}; it stays out of every member catalog until then.`);
  }
  const refusedKey = JSON.stringify(refused);
  const refusedCache = path.join(cacheDir, '_refused.json');
  const prevRefused = await readFile(refusedCache, 'utf8').catch(() => '[]');
  if (refusedKey !== prevRefused) {
    await writeFile(refusedCache, refusedKey);
    const notifyScript = path.join(repoRoot, 'control', 'notify.mjs');
    if (refused.length && existsSync(notifyScript)) {
      // The notice must carry the SAME reason the log does. It used to hardcode
      // the category, so a duplicate-id refusal told the operator to look at a
      // category that was perfectly valid and sent them hunting (2026-08-26).
      const line = `catalog publish refused: ${refused.map((r) => `${r.id} (${r.why || `category "${r.category}"`})`).join(', ')}. `
        + `Refused items stay out of every member catalog until the manifest is fixed; the catalog takes exactly ${CATEGORIES.join('|')}.`;
      await new Promise((resolve) => execFile('node', [notifyScript, line], { cwd: repoRoot }, () => resolve()));
    }
  }

  // WHO GETS A CATALOGUE. Seats, plus every JOINED tie (one-inbox, spec
  // 2026-08-17). This loop walked registry/members/ alone, and since a joined
  // tie has no row there, the single most likely way this whole build fails is
  // right here: a joined member wired correctly, holding an empty inbox
  // forever, with nothing anywhere saying why.
  const audience = [];
  for (const f of (await readdir(path.join(repoRoot, 'registry', 'members')).catch(() => []))) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
    audience.push({ slug: f.replace(/\.yaml$/, ''), seat: true, file: f });
  }
  const seatSlugs = new Set(audience.map((a) => a.slug));
  for (const f of (await readdir(path.join(repoRoot, 'registry', 'ties')).catch(() => []))) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const slug = f.replace(/\.json$/, '');
    if (seatSlugs.has(slug)) continue;   // a seat wins, same rule as tie-reconcile
    audience.push({ slug, seat: false, file: f });
  }

  let pushed = 0, unchanged = 0, skipped = 0, failed = 0;
  // Items in the catalogue with no content on disk: collected by id+kind
  // (not per member: the fact is a pure library-disk fact, so a Set
  // dedupes it for free) and named in the run's log line at the end,
  // instead of the old inline `continue` that dropped them with no signal.
  const missingPayloads = new Set();

  for (const { slug, seat, file: f } of audience) {
    if (seat) {
      const row = await readFile(path.join(repoRoot, 'registry', 'members', f), 'utf8');
      const n = normalizeRow(extractRow(row), { anchorSlug });
      if (n.status !== 'active') { skipped++; continue; }                 // membership gate
      if (anchorSlug && n.anchor !== anchorSlug) { skipped++; continue; } // anchor gate (T1.4)
    } else {
      // A tie has no status or anchor to gate on: it is a tie to THIS rock by
      // construction (tie-reconcile only records ties the directory reports for
      // this org) and an ended one has its record removed. Entitlement still
      // applies below, and for a joined member it is the `tied` audience or
      // nothing, since a chosen-list names seat slugs.
      const rec = await readFile(path.join(repoRoot, 'registry', 'ties', f), 'utf8').catch(() => '');
      if (!rec) { skipped++; continue; }
    }

    const view = renderCatalog({ policy, library, slug, rock: anchorSlug });
    const itemsKey = JSON.stringify(view.items);

    // Pack expansion (delivery-model step 6): an entry in some entitled
    // pack's contents.* that resolved to nothing real is a fact about the
    // pack's OWN manifest, not about this one member, so it recurs
    // identically for every member entitled to that pack. Fold it into the
    // same missing-payload reporting channel below (declared before this
    // loop) rather than inventing a second one; the Set dedupes the repeats.
    for (const m of view.missing || []) missingPayloads.add(`${m.entry} (pack ${m.pack}: ${m.reason})`);

    const push = (dir, dest) => new Promise((resolve) => {
      execFile('node', [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, dir, dest],
        { cwd: repoRoot, timeout: 120_000 },
        (err, stdout, stderr) => {
          if (err) console.log(`catalog-reconcile: ${slug}: push-down refused/failed: ${String(stderr || stdout).trim().split('\n').pop()}`);
          resolve(!err);
        });
    });

    // The withdrawal leg (delivery-model, step 4): un-offer whatever this
    // destination no longer entitles. keepIds empty means --none (un-offer
    // everything under this destination is a real, explicit state, never a
    // parsing accident). Failures are logged and folded into `ok` exactly
    // like a push failure, so a failed prune also holds the cache back and
    // the next tick retries it rather than being recorded as done.
    const prune = (dest, keepIds) => new Promise((resolve) => {
      const args = keepIds.length ? [slug, dest, ...keepIds] : [slug, dest, '--none'];
      execFile('node', [path.join(repoRoot, 'orchestrator', 'prune-down.mjs'), ...args],
        { cwd: repoRoot, timeout: 120_000 },
        (err, stdout, stderr) => {
          if (err) console.log(`catalog-reconcile: ${slug}: prune-down refused/failed: ${String(stderr || stdout).trim().split('\n').pop()}`);
          resolve(!err);
        });
    });

    // THE PACKAGES, NOT ONLY THE MANIFEST (one-inbox, 2026-08-17).
    //
    // This pushed catalog.json alone, because the packages themselves used to
    // arrive later: the member clicked Install, the request rode a heartbeat up,
    // and requests-reconcile fulfilled it with push-skill. With pickup made
    // local (spec § 5), that round trip is gone and there would be nothing on
    // the member's disk to pick up: the Install button would refuse every
    // offer with "not in your inbox" and the whole channel would look broken.
    //
    // So an offer materialises WHOLE. Being offered is still not being
    // installed: the package sits in the inbox staging area and nothing runs it
    // until the member picks it up. That is exactly the always-pickup ruling,
    // and it is why this writes no registry skills_installed entry the way
    // push-skill does.
    //
    // Delivery-model step 3 extends "whole" from skills alone to every kind:
    // group this member's entitled, non-pack items by destination (DEST
    // above), stage each destination's real payload into its own temp root,
    // and hash exactly what got staged. A pack offers its CONTENTS, which are
    // items in their own right elsewhere in the library; pack expansion
    // itself is step 6 and stays skipped here.
    const buckets = {};
    for (const item of view.items || []) {
      if (item.kind === 'pack') continue;
      const dest = DEST[item.kind];
      if (!dest) continue;
      (buckets[dest] ||= []).push(item);
    }

    const staged = {}; // dest -> { dir, hash }, only for destinations with >=1 real payload
    for (const [dest, items] of Object.entries(buckets)) {
      const tmp = await mkdtemp(path.join(tmpdir(), 'catalog-pkg-'));
      let any = false;
      for (const item of items.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        if (await stageItem(item, tmp)) any = true;
        else missingPayloads.add(`${item.id} (${item.kind})`);
      }
      if (any) staged[dest] = { dir: tmp, hash: await hashPayload(tmp) };
      else await rm(tmp, { recursive: true, force: true });
    }

    // What this member is entitled to right now, per reconcile-owned
    // destination, ids only, sorted. Built from the same buckets the staging
    // loop above used, so a destination this member is entitled to nothing
    // under (dropped to zero, or never had anything) still gets an entry
    // here (an empty one) even though it never got a `staged` temp dir.
    const entitledByDest = {};
    for (const dest of RECONCILE_DESTS) {
      entitledByDest[dest] = (buckets[dest] || []).map((item) => item.id).sort();
    }

    const cacheFile = path.join(cacheDir, `${slug}.json`);
    let cache = null;
    try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { cache = null; }
    const prevContent = (cache && typeof cache.content === 'object' && cache.content) || {};

    // PUSH PAYLOADS BEFORE catalog.json (requirement 1). The manifest used to
    // go first, so a partial failure could advertise an item whose payload
    // never landed, and the member's own install path reads that as "not in
    // your inbox... or it has not arrived yet" for something that will NEVER
    // arrive. Pushing every real payload first, and the manifest last, closes
    // that window: the manifest only ever describes what already landed.
    let ok = true, didWork = false;
    const newContent = {};
    for (const [dest, { dir, hash }] of Object.entries(staged)) {
      newContent[dest] = hash;
      if (prevContent[dest] === hash) { await rm(dir, { recursive: true, force: true }); continue; }
      didWork = true;
      const success = await push(dir, dest);
      await rm(dir, { recursive: true, force: true });
      ok = ok && success;   // requirement 2: AND across every push
    }

    if (!cache || cache.items !== itemsKey) {
      didWork = true;
      const payload = await mkdtemp(path.join(tmpdir(), 'catalog-'));
      await writeFile(path.join(payload, 'catalog.json'),
        JSON.stringify({ ...view, generated: new Date().toISOString() }, null, 2) + '\n');
      const success = await push(payload, 'catalog');
      await rm(payload, { recursive: true, force: true });
      ok = ok && success;

      // Prune, gated on itemsKey (not on a payload hash moving): withdrawal
      // is exactly the case where a destination's entitled ids go to zero,
      // and a destination with zero entitled items never gets a `staged`
      // entry above, so it would never see a hash change to react to. The
      // items key is what actually changed, so it is what gates this.
      // Prune runs only when everything pushed so far this tick succeeded
      // (requirement: a transport failure must never cause a reap based on
      // a half-built view), and a prune failure folds into `ok` the same
      // way a push failure does, so the cache write below is withheld and
      // the next tick retries.
      if (ok) {
        for (const dest of RECONCILE_DESTS) {
          const pruneOk = await prune(dest, entitledByDest[dest] || []);
          ok = ok && pruneOk;
        }
      }
    }

    if (!didWork) { unchanged++; continue; }
    // Cache write gated on all-ok (requirement 2): a partial failure leaves
    // the cache exactly as it was, so the next tick retries everything this
    // tick attempted rather than a half-delivered member being marked done.
    if (ok) { await writeFile(cacheFile, JSON.stringify({ items: itemsKey, content: newContent })); pushed++; }
    else failed++;
  }

  const missingLine = missingPayloads.size
    ? `; missing payload: ${[...missingPayloads].sort().join(', ')}`
    : '';
  console.log(`catalog-reconcile: ${pushed} pushed, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed; `
    + `${library.length} publishable, ${refused.length} refused${missingLine}.`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error(`catalog-reconcile: ${e.message}`); process.exit(0); });  // fail-soft: reconcile-all runs on
}
