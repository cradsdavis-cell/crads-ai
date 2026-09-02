#!/usr/bin/env node
// community-list.mjs: what communities this box belongs to, one JSON line
// (self-host pivot, 2026-09-01). Read-only.
//
//   node community-list.mjs <state-dir>
//
// Prints exactly one line, `COMMUNITIES_STATE {...}`, the same single-line
// contract SKILLS_STATE and PROMPTS_STATE use, so the app parses it without
// guessing where a stream ends. Item counts are a shallow, bounded read of
// the pulled checkout; they are a summary for a card, not an inventory.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { inboxDirFor, listCommunities, readCommonsItems, seenKey } from './commons-lib.mjs';

const state = String(process.argv[2] || '');
const out = { communities: [], error: null };

const dirsIn = (p) => {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name); }
  catch { return []; }
};
const filesIn = (p, ext) => {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile() && (!ext || d.name.endsWith(ext))).map((d) => d.name); }
  catch { return []; }
};

if (!state) { out.error = 'usage: community-list <state-dir>'; }
else {
  try {
    for (const rec of listCommunities(state)) {
      const root = inboxDirFor(state, rec.org);
      let prompts = 0;
      for (const pack of dirsIn(path.join(root, 'prompts')).slice(0, 50)) {
        prompts += filesIn(path.join(root, 'prompts', pack), '.md').length;
      }
      let dirs = 0;
      for (const pack of dirsIn(path.join(root, 'dirs')).slice(0, 50)) {
        dirs += dirsIn(path.join(root, 'dirs', pack)).length;
      }
      let pages = filesIn(path.join(root, 'offers-pages'), '.html').length;
      for (const pack of dirsIn(path.join(root, 'pages')).slice(0, 50)) {
        pages += filesIn(path.join(root, 'pages', pack), '.html').length;
      }
      // The shared-library view (2026-09-02, ruling 4): what the checkout's
      // own manifest names, each item flagged fresh when it arrived or grew a
      // version since the member's last look (community-seen stamps the look).
      const seen = rec.seen && typeof rec.seen === 'object' && !Array.isArray(rec.seen) ? rec.seen : {};
      const items = readCommonsItems(state, rec.org).map((it) => ({
        ...it,
        fresh: !(seenKey(it) in seen) || (parseInt(seen[seenKey(it)], 10) || 0) < it.version,
      }));
      out.communities.push({
        org: rec.org,
        org_display: rec.org_display || rec.org,
        url: rec.url,
        ...(rec.branch ? { branch: rec.branch } : {}),
        joined: rec.joined || '',
        status: rec.status || 'joined',
        ...(rec.access_hint ? { access_hint: rec.access_hint } : {}),
        ...(rec.invite_from ? { invite_from: rec.invite_from } : {}),
        last_ok: rec.last_ok || '',
        last_sha: rec.last_sha || '',
        last_error: rec.last_error || '',
        counts: {
          skills: dirsIn(path.join(root, 'skills')).length,
          packs: dirsIn(path.join(root, 'packs')).length,
          pages,
          prompts,
          dirs,
        },
        items,
        fresh_count: items.filter((it) => it.fresh).length,
      });
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
}

process.stdout.write('COMMUNITIES_STATE ' + JSON.stringify(out) + '\n');
