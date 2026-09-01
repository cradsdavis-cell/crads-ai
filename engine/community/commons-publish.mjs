#!/usr/bin/env node
// commons-publish.mjs: put the rock's catalogue into its commons repo
// (self-host pivot, 2026-09-01; docs/self-host-design.md section 3).
//
//   node commons-publish.mjs <state-dir> <brain-root>
//
// Publish reads the rock's EXISTING library zones (skills-library/, packs/,
// prompts-library/, pages-library/, dirs-library/, the same roots item-list
// and the write verbs use) and lays them out in the commons repo in the
// PUSH-DOWN INBOX SHAPE, because a member's box mounts the commons where a
// joined rock's inbox lands and every pickup surface already reads that shape:
//
//   skills/<id>/                      skill packages (SKILL.md + skill.yaml)
//   packs/<id>/pack.yaml              pack envelopes
//   pages/<pack>/<id>.html            pack pages          } page-install
//   offers-pages/<id>.html (+ .json)  standalone pages    }
//   prompts/<pack-or-library>/<id>.md prompts (prompts-list walks these)
//   dirs/<pack-or-library>/<id>/      folders (+ <id>.yaml manifest sibling)
//   context/                          pack context files, read in place
//   catalog/catalog.json              the manifest catalog-list merges
//   commons.yaml                      org identity + publish stamp
//
// Curation IS the catalogue: everything in the library zones is published,
// whole. There is no per-member entitlement in a commons; membership (read
// access to the repo) is the entitlement, which is the model's point.
//
// Pages pass the SAME page-lint gate publish-time as everywhere else; a
// failing page is skipped and named, never shipped and never silently
// dropped. Symlinks are never followed and never recreated. The commons never
// receives member data: this script reads library zones and writes the repo,
// nothing else.
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { lintPage } from '../appshell/page-lint.mjs';
import {
  allowFileFromEnv, gitEnvFor, readCommonsConf, readGhToken, tokenArgsFor, validGitUrl,
} from './commons-lib.mjs';

const [state, brain] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain) die('usage: commons-publish <state-dir> <brain-root>');

const conf = readCommonsConf(state);
if (!conf) die('no commons is configured yet. Run commons init first (the Commons card on the Catalogue page).');
if (!validGitUrl(conf.url, { allowFile: allowFileFromEnv() }).ok) die('the configured commons URL is not usable; run commons init again.');

const SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];
const realDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const realFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const idsIn = (root) => {
  try { return readdirSync(root).filter((n) => SAFE.test(n) && !n.startsWith('_') && realDir(path.join(root, n))).sort(); }
  catch { return []; }
};
const yget = (yaml, key) => (yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm')) || [, ''])[1].trim();
const flowList = (yaml, key) => {
  const m = yaml.match(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
};
const copyNoLinks = (src, dst) => cpSync(src, dst, {
  recursive: true, dereference: false, filter: (s) => !lstatSync(s).isSymbolicLink(),
});
const category = (c) => (CATEGORIES.includes(c) ? c : 'other');
// eslint-disable-next-line no-control-regex
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

// ---- the working clone -----------------------------------------------------
const WORK = path.join(state, '.commons-out');
const keyPath = path.join(state, 'secrets', 'commons_deploy_key');
const env = gitEnvFor(conf, { keyPath: existsSync(keyPath) ? keyPath : '' });
const tokenArgs = tokenArgsFor(conf.url, readGhToken(state));
const git = (args, opts = {}) => execFileSync('git', [...tokenArgs, ...args], {
  encoding: 'utf8', env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
});

let sameRemote = false;
try { sameRemote = existsSync(path.join(WORK, '.git')) && git(['-C', WORK, 'remote', 'get-url', 'origin']).trim() === conf.url; } catch { sameRemote = false; }
try {
  if (sameRemote) {
    git(['-C', WORK, 'fetch', 'origin']);
    try { git(['-C', WORK, 'reset', '--hard', conf.branch ? `origin/${conf.branch}` : 'origin/HEAD']); }
    catch { git(['-C', WORK, 'reset', '--hard', 'FETCH_HEAD']); }
  } else {
    rmSync(WORK, { recursive: true, force: true });
    git(['clone', ...(conf.branch ? ['-b', conf.branch] : []), '--', conf.url, WORK]);
  }
} catch (e) {
  const msg = String((e && (e.stderr || e.message)) || e).trim();
  // A brand-new repo with no commits: clone can refuse the -b, or fetch has
  // nothing. Start the branch locally; the push below creates it remotely.
  if (/Remote branch .* not found|couldn't find remote ref|warning: remote HEAD refers/i.test(msg) || /You appear to have cloned an empty repository/i.test(msg)) {
    rmSync(WORK, { recursive: true, force: true });
    try {
      git(['clone', '--', conf.url, WORK]);
      if (conf.branch) git(['-C', WORK, 'checkout', '-B', conf.branch]);
    } catch (e2) {
      die(`could not reach the commons repository: ${String((e2 && (e2.stderr || e2.message)) || e2).trim().slice(0, 300)}`);
    }
  } else {
    die(`could not reach the commons repository: ${msg.slice(0, 300)}`);
  }
}

// ---- stage the catalogue into the inbox shape ------------------------------
const MANAGED = ['skills', 'packs', 'pages', 'offers-pages', 'prompts', 'dirs', 'context', 'catalog', 'commons.yaml'];
for (const m of MANAGED) rmSync(path.join(WORK, m), { recursive: true, force: true });

const items = [];
const skipped = [];
const stagedSkills = new Set();

const stageSkill = (id) => {
  if (stagedSkills.has(id)) return true;
  const src = path.join(brain, 'skills-library', id);
  if (!realFile(path.join(src, 'SKILL.md')) || !realFile(path.join(src, 'skill.yaml'))) return false;
  copyNoLinks(src, path.join(WORK, 'skills', id));
  stagedSkills.add(id);
  return true;
};

// skills
for (const id of idsIn(path.join(brain, 'skills-library'))) {
  if (!stageSkill(id)) { skipped.push(`${id} (skill: needs both SKILL.md and skill.yaml)`); continue; }
  const yaml = readFileSync(path.join(brain, 'skills-library', id, 'skill.yaml'), 'utf8');
  items.push({
    id, kind: 'skill',
    version: parseInt(yget(yaml, 'version'), 10) || 1,
    category: category(yget(yaml, 'category')),
    description: clean(yget(yaml, 'description') || yget(yaml, 'title'), 200),
  });
}

// packs: the envelope is copied whole-file; the payloads are staged into the
// inbox shape the member-side installers read (pages/<pack>/, prompts/<pack>/,
// dirs/<pack>/, context/), with the pack's own staging directory preferred and
// the standalone libraries as the fallback source for skills.
for (const id of idsIn(path.join(brain, 'packs'))) {
  const packDir = path.join(brain, 'packs', id);
  const packYamlPath = path.join(packDir, 'pack.yaml');
  if (!realFile(packYamlPath)) { skipped.push(`${id} (pack: no pack.yaml)`); continue; }
  const yaml = readFileSync(packYamlPath, 'utf8');
  mkdirSync(path.join(WORK, 'packs', id), { recursive: true });
  cpSync(packYamlPath, path.join(WORK, 'packs', id, 'pack.yaml'), { dereference: false });

  const contents = { skills: [], dirs: [], pages: 0, files: 0 };
  for (const sid of flowList(yaml, 'skills')) {
    if (SAFE.test(sid) && stageSkill(sid)) contents.skills.push(sid);
    else skipped.push(`${id}/${sid} (pack skill missing from skills-library)`);
  }
  for (const pid of flowList(yaml, 'pages')) {
    if (!SAFE.test(pid)) { skipped.push(`${id}/${pid} (page id not kebab-case)`); continue; }
    const src = path.join(packDir, 'pages', `${pid}.html`);
    if (!realFile(src)) { skipped.push(`${id}/${pid} (pack page file missing)`); continue; }
    const lint = lintPage(readFileSync(src, 'utf8'));
    if (!lint.ok) { skipped.push(`${id}/${pid} (page fails the page contract: ${lint.violations[0].detail})`); continue; }
    mkdirSync(path.join(WORK, 'pages', id), { recursive: true });
    cpSync(src, path.join(WORK, 'pages', id, `${pid}.html`), { dereference: false });
    contents.pages++;
  }
  for (const entry of flowList(yaml, 'prompts')) {
    if (entry.includes('..') || entry.length > 120) { skipped.push(`${id}/${entry} (prompt path refused)`); continue; }
    const src = path.join(packDir, entry.startsWith('prompts/') ? entry : path.join('prompts', entry));
    if (!realFile(src)) { skipped.push(`${id}/${entry} (pack prompt file missing)`); continue; }
    mkdirSync(path.join(WORK, 'prompts', id), { recursive: true });
    cpSync(src, path.join(WORK, 'prompts', id, path.basename(src)), { dereference: false });
  }
  for (const entry of flowList(yaml, 'context')) {
    if (entry.includes('..') || entry.length > 120) { skipped.push(`${id}/${entry} (context path refused)`); continue; }
    const src = path.join(packDir, entry.startsWith('context/') ? entry : path.join('context', entry));
    if (!realFile(src)) { skipped.push(`${id}/${entry} (pack context file missing)`); continue; }
    mkdirSync(path.join(WORK, 'context'), { recursive: true });
    cpSync(src, path.join(WORK, 'context', path.basename(src)), { dereference: false });
    contents.files++;
  }
  for (const did of flowList(yaml, 'dirs')) {
    if (!SAFE.test(did)) { skipped.push(`${id}/${did} (folder id not kebab-case)`); continue; }
    const src = path.join(packDir, 'dirs', did);
    if (!realDir(src)) { skipped.push(`${id}/${did} (pack folder missing)`); continue; }
    copyNoLinks(src, path.join(WORK, 'dirs', id, did));
    const man = path.join(packDir, 'dirs', `${did}.yaml`);
    if (realFile(man)) cpSync(man, path.join(WORK, 'dirs', id, `${did}.yaml`), { dereference: false });
    contents.dirs.push(did);
  }
  items.push({
    id, kind: 'pack',
    version: parseInt(yget(yaml, 'version'), 10) || 1,
    category: category(yget(yaml, 'category')),
    description: clean(yget(yaml, 'description') || yget(yaml, 'title'), 200),
    contents,
  });
}

// standalone prompts: prompts-library/<id>/ (prompt.yaml + PROMPT.md) becomes
// prompts/library/<id>.md with the title as frontmatter, the exact file shape
// prompts-list parses.
for (const id of idsIn(path.join(brain, 'prompts-library'))) {
  const src = path.join(brain, 'prompts-library', id);
  const body = realFile(path.join(src, 'PROMPT.md')) ? readFileSync(path.join(src, 'PROMPT.md'), 'utf8') : '';
  if (!body.trim() || !realFile(path.join(src, 'prompt.yaml'))) { skipped.push(`${id} (prompt: needs prompt.yaml and PROMPT.md)`); continue; }
  const yaml = readFileSync(path.join(src, 'prompt.yaml'), 'utf8');
  const title = clean(yget(yaml, 'title'), 120) || id;
  mkdirSync(path.join(WORK, 'prompts', 'library'), { recursive: true });
  writeFileSync(path.join(WORK, 'prompts', 'library', `${id}.md`), `---\ntitle: "${title.replace(/"/g, "'")}"\n---\n${body}`);
  items.push({ id, kind: 'prompt', version: parseInt(yget(yaml, 'version'), 10) || 1, category: category(yget(yaml, 'category')), title });
}

// standalone pages: pages-library/<id>/ (page.yaml + page.html) becomes
// offers-pages/<id>.html + <id>.json, gated by page-lint.
for (const id of idsIn(path.join(brain, 'pages-library'))) {
  const src = path.join(brain, 'pages-library', id);
  if (!realFile(path.join(src, 'page.html')) || !realFile(path.join(src, 'page.yaml'))) { skipped.push(`${id} (page: needs page.yaml and page.html)`); continue; }
  const html = readFileSync(path.join(src, 'page.html'), 'utf8');
  const lint = lintPage(html);
  if (!lint.ok) { skipped.push(`${id} (page fails the page contract: ${lint.violations[0].detail})`); continue; }
  const yaml = readFileSync(path.join(src, 'page.yaml'), 'utf8');
  const title = clean(yget(yaml, 'title'), 120) || id;
  mkdirSync(path.join(WORK, 'offers-pages'), { recursive: true });
  writeFileSync(path.join(WORK, 'offers-pages', `${id}.html`), html);
  writeFileSync(path.join(WORK, 'offers-pages', `${id}.json`), JSON.stringify({ title, from: conf.org_display || conf.org }) + '\n');
  items.push({ id, kind: 'page', version: parseInt(yget(yaml, 'version'), 10) || 1, category: category(yget(yaml, 'category')), title, description: clean(yget(yaml, 'description'), 200) });
}

// standalone folders: dirs-library/<id>/ (dir.yaml + files/) becomes
// dirs/library/<id>/ with the manifest as the .yaml sibling dir-install reads.
for (const id of idsIn(path.join(brain, 'dirs-library'))) {
  const src = path.join(brain, 'dirs-library', id);
  if (!realDir(path.join(src, 'files')) || !realFile(path.join(src, 'dir.yaml'))) { skipped.push(`${id} (folder: needs dir.yaml and files/)`); continue; }
  copyNoLinks(path.join(src, 'files'), path.join(WORK, 'dirs', 'library', id));
  const yaml = readFileSync(path.join(src, 'dir.yaml'), 'utf8');
  const kindLabel = (yaml.match(/^kind:\s*(['"]?)([a-z0-9-]{1,32})\1\s*$/m) || [])[2] || '';
  mkdirSync(path.join(WORK, 'dirs', 'library'), { recursive: true });
  writeFileSync(path.join(WORK, 'dirs', 'library', `${id}.yaml`), (kindLabel ? `kind: ${kindLabel}\n` : '') + `title: "${(clean(yget(yaml, 'title'), 120) || id).replace(/"/g, "'")}"\n`);
  items.push({ id, kind: 'dir', version: parseInt(yget(yaml, 'version'), 10) || 1, category: category(yget(yaml, 'category')), title: clean(yget(yaml, 'title'), 120) || id, description: clean(yget(yaml, 'description'), 200) });
}

// ---- the manifest ----------------------------------------------------------
// No timestamps in the repo content on purpose: the tree must be a pure
// function of the catalogue, so an unchanged catalogue republishes as a
// no-op instead of an empty commit. The publish stamp lives in
// <state>/commons-publish.json on the rock.
const rockLabel = conf.org_display || conf.org;
mkdirSync(path.join(WORK, 'catalog'), { recursive: true });
writeFileSync(path.join(WORK, 'catalog', 'catalog.json'), JSON.stringify({
  rock: rockLabel,
  items: items.map((it) => ({ ...it, rock: rockLabel, rock_id: conf.org })),
}, null, 2) + '\n');
const counts = items.reduce((a, it) => { a[it.kind] = (a[it.kind] || 0) + 1; return a; }, {});
writeFileSync(path.join(WORK, 'commons.yaml'),
  `org: ${conf.org}\norg_display: "${rockLabel.replace(/"/g, "'")}"\n`
  + `counts: {${Object.entries(counts).map(([k, v]) => ` ${k}: ${v}`).join(',')} }\n`);

// ---- commit + push ---------------------------------------------------------
git(['-C', WORK, 'add', '-A']);
let changed = true;
try { git(['-C', WORK, 'diff', '--cached', '--quiet']); changed = false; } catch { changed = true; }
if (changed) {
  git(['-C', WORK, '-c', 'user.name=AI OS commons', '-c', 'user.email=commons@ai-os.local',
    'commit', '-q', '-m', `commons: publish ${items.length} item(s)`]);
  try {
    git(['-C', WORK, 'push', 'origin', conf.branch ? `HEAD:${conf.branch}` : 'HEAD']);
  } catch (e) {
    die(`the publish is committed locally but the push was refused: ${String((e && (e.stderr || e.message)) || e).trim().slice(0, 300)}`);
  }
}

let sha = '';
try { sha = git(['-C', WORK, 'rev-parse', '--short', 'HEAD']).trim(); } catch { /* fine */ }
const pub = { at: new Date().toISOString(), items: items.length, skipped: skipped.length, sha };
writeFileSync(`${path.join(state, 'commons-publish.json')}.tmp`, JSON.stringify(pub, null, 2) + '\n');
renameSync(`${path.join(state, 'commons-publish.json')}.tmp`, path.join(state, 'commons-publish.json'));

if (!changed) console.log(`OK: the commons already matches your catalogue (${items.length} item(s), nothing to publish).`);
else console.log(`OK: published ${items.length} item(s) to the ${rockLabel} commons${sha ? ` (${sha})` : ''}. Members receive them on their next sync, to install when they choose.`);
for (const s of skipped) console.log(`SKIPPED: ${s}`);
