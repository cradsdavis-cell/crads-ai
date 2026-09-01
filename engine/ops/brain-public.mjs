#!/usr/bin/env node
// brain-public.mjs — the rock's public-brain toolbelt (S9, ruling R7 of the
// 2026-08-09 grilling). A rock may share a MARKED SUBSET of its own wiki with
// its tied pebbles: frontmatter `public: true` is the one source of truth and
// the app's ticks write it through here.
//
//   node brain-public.mjs <brainRoot> list
//   node brain-public.mjs <brainRoot> set <page> on|off
//   node brain-public.mjs <brainRoot> push [--if-changed]
//   node brain-public.mjs <brainRoot> toggle on|off
//
// LOCAL ONLY since the self-host strip (2026-09-01). `push` and `toggle` used
// to POST the subset and the share flag to the central directory, which served
// it tie-gated; the directory is deleted, so both verbs now stop at the box:
// the flags and the sharing mirror are kept true on disk, nothing leaves, and
// serving the marked pages to tied pebbles is the commons model's to rebuild.
// The verbs stay (the Sharing card shells them) and exit 0 with an honest line
// rather than erroring at a dead host every half hour.
//
// The leak gates are unchanged and still both apply:
//   1. `set` REFUSES personal/** and enclave pages outright;
//   2. `push` re-filters through the same guards, so a hand-edited flag on a
//      guarded page is never counted shareable.
// The wiki scope is brain-list's: root pages + notes/ decisions/ insights/ —
// machinery dirs cannot even be named here.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isEnclavePage } from '../lib/org-publish.mjs';

const br = path.resolve(process.argv[2] || '');
const cmd = String(process.argv[3] || '');
if (!process.argv[2] || !cmd) { console.error('usage: brain-public.mjs <brainRoot> list|set|push|toggle ...'); process.exit(1); }
const stateDir = process.env.AIOS_STATE_DIR || '/state';

// `wiki` IS IN SCOPE (finding 107, 2026-08-13). Without it this walked root .md
// plus three dirs that a rock brain barely uses, so `list` returned exactly
// CLAUDE.md, README.md and notes/README.md on a fully onboarded rock. The eight
// layers /onboard writes to wiki/_layers/ and the people it writes to wiki/people/
// were not merely unshared, they were UNSHAREABLE: `set` refuses a page `list`
// does not know, so there was no way to mark them public at all.
//
// Sharing the brain with tied pebbles is the reason a rock exists, and the only
// pages it could share were the three the template ships with.
const WIKI_DIRS = new Set(['notes', 'decisions', 'insights', 'wiki']);
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

function pages() {
  const out = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (rel === '' && !WIKI_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.name.endsWith('.md')) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(br, '');
  return out.sort();
}
const isPersonal = (page) => page.startsWith('personal/') || page.includes('/personal/');
const fmBlock = (text) => {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? null : { head: text.slice(0, end + 4), end: end + 4 };
};
const isPublic = (text) => {
  const fm = fmBlock(text);
  return !!fm && /^public:\s*true\s*$/m.test(fm.head);
};
const titleOf = (text, page) =>
  (text.match(/^#\s+(.+?)\s*$/m) || [])[1] || page.replace(/\.md$/, '').split('/').pop().replace(/-/g, ' ');

function guard(page, text) {
  if (isPersonal(page)) return 'personal/** never leaves the mineral';
  if (isEnclavePage(text)) return 'enclave pages never leave the mineral';
  return null;
}

function orgFacts() {
  const pol = rd(path.join(br, 'org-policy.yaml')) || '';
  const org = ((pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim();
  return { org };
}

async function main() {
  if (cmd === 'list') {
    const rows = pages().map((page) => {
      const text = rd(path.join(br, page)) || '';
      return { page, title: titleOf(text, page), public: isPublic(text), guarded: !!guard(page, text) };
    });
    console.log('PUBLIC_BRAIN ' + JSON.stringify({ pages: rows, public: rows.filter((r) => r.public).length }));
    return;
  }
  if (cmd === 'set') {
    const page = String(process.argv[4] || '');
    const on = process.argv[5] === 'on';
    if (!pages().includes(page)) { console.error(`ERROR: no such wiki page: ${page}`); process.exit(1); }
    const p = path.join(br, page);
    let text = rd(p) || '';
    if (on) {
      const why = guard(page, text);
      if (why) { console.error(`ERROR: refused: ${why}`); process.exit(1); }
    }
    const fm = fmBlock(text);
    if (/^public:/m.test(fm ? fm.head : '')) {
      text = text.slice(0, fm.end).replace(/^public:.*$/m, `public: ${on}`) + text.slice(fm.end);
    } else if (on && fm) {
      text = text.replace(/^---\n/, '---\npublic: true\n');
    } else if (on) {
      text = `---\npublic: true\n---\n` + text;
    }   // off with no flag anywhere: nothing to do
    writeFileSync(p, text);
    console.log(`OK: ${page} is now ${on ? 'PUBLIC to tied pebbles (after push)' : 'private'}`);
    return;
  }
  if (cmd === 'push') {
    const { org } = orgFacts();
    if (!org) { console.error('ERROR: this brain has no org name; is it a rock?'); process.exit(1); }
    const items = [];
    for (const page of pages()) {
      const text = rd(path.join(br, page)) || '';
      if (!isPublic(text)) continue;
      if (guard(page, text)) continue;   // gate 2: a hand-set flag on a guarded page stays home
      let mtime = 0; try { mtime = Math.round(statSync(path.join(br, page)).mtimeMs); } catch { /* 0 */ }
      items.push({ id: page.replace(/\.md$/, ''), title: titleOf(text, page), updated: mtime,
        content_b64: Buffer.from(text, 'utf8').toString('base64') });
    }
    const body = JSON.stringify({ org, items });
    if (process.argv.includes('--if-changed')) {
      // the change guard survives the strip, so a future serving surface can
      // reuse it and a caller can still ask "did anything move"
      const hashFile = path.join(stateDir, 'cockpit', 'brainpub-hash');
      const { createHash } = await import('node:crypto');
      const h = createHash('sha256').update(body).digest('hex');
      if (rd(hashFile) === h) { console.log(`OK: unchanged (${items.length} public pages), nothing pushed`); return; }
      mkdirSync(path.dirname(hashFile), { recursive: true });
      writeFileSync(hashFile, h);
    }
    // No POST: the central directory that served the subset is gone.
    console.log(`OK: ${items.length} public page${items.length === 1 ? '' : 's'} marked shareable; `
      + 'nothing is pushed anywhere (the central directory is gone; sharing to tied pebbles is moving to the commons model)');
    return;
  }
  if (cmd === 'toggle') {
    const on = process.argv[4] === 'on';
    const { org } = orgFacts();
    if (!org) { console.error('ERROR: this brain has no org name; is it a rock?'); process.exit(1); }
    // mirror for the Sharing card + the cron's gate; merged, never clobbered.
    // Local only: there is no directory flag to flip any more.
    const shPath = path.join(stateDir, 'cockpit', 'sharing.json');
    let sh = {}; try { sh = JSON.parse(rd(shPath) || '{}'); } catch { sh = {}; }
    sh.public_brain = on;
    mkdirSync(path.dirname(shPath), { recursive: true });
    writeFileSync(shPath, JSON.stringify(sh, null, 2) + '\n');
    console.log(`OK: the public brain is ${on ? 'ON (recorded on this box; serving moves to the commons model)' : 'OFF'}`);
    return;
  }
  console.error(`ERROR: unknown command: ${cmd}`);
  process.exit(1);
}
await main();
