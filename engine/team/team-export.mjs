#!/usr/bin/env node
// team-export.mjs <state>: what goes home with someone who leaves a team.
//
// Their personal/ folder AND every page they marked `enclave: true` anywhere in
// their wiki (the teams security review, 2026-10-11, found the first version
// exported personal/ only, so a private page elsewhere was destroyed with the
// server). Prints one line, then the archive:
//   TEAM_EXPORT {"files":N,"bytes":B,"sha256":"..."}
//   <base64 of the .tar.gz>
// The app checks the hash and that the archive opens BEFORE it cuts anything.
import { readdirSync, readFileSync, lstatSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { isEnclavePage } from '../lib/org-publish.mjs';

export function exportList(stateDir) {
  const wiki = path.join(stateDir, 'wiki');
  const out = [];
  if (existsSync(path.join(wiki, 'personal'))) out.push('personal');
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === 'personal') continue;
      const p = path.join(dir, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r);
      else if (e.name.endsWith('.md') && isEnclavePage(readFileSync(p, 'utf8'))) out.push(r);
    }
  };
  walk(wiki, '');
  return out;
}

export function buildExport(stateDir) {
  const list = exportList(stateDir);
  if (!list.length) return { files: 0, archive: null };
  const tmp = mkdtempSync(path.join(tmpdir(), 'team-export-'));
  try {
    const file = path.join(tmp, 'export.tar.gz');
    execFileSync('tar', ['czf', file, '-C', path.join(stateDir, 'wiki'), '--', ...list], { stdio: 'pipe' });
    const archive = readFileSync(file);
    return { files: list.length, archive, sha256: createHash('sha256').update(archive).digest('hex') };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const r = buildExport(process.argv[2] || '/state');
  if (!r.archive) { process.stdout.write('TEAM_EXPORT {"files":0}\n'); process.exit(0); }
  process.stdout.write(`TEAM_EXPORT ${JSON.stringify({ files: r.files, bytes: r.archive.length, sha256: r.sha256 })}\n${r.archive.toString('base64')}\n`);
}
