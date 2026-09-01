#!/usr/bin/env node
// page-delete.mjs <boxDir> <id> — remove ONE box-hosted page: the fragment at
// <box>/dashboard/pages/<id>.html AND its entry in <box>/dashboard/pages.json.
// Panel iteration 2, R15 (2026-08-23): seeded example pages are deletable, and
// so is any other page the member no longer wants. Nothing else in the manifest
// is touched; unknown ids are a named error, never a silent OK. The id is
// tombstoned in <box>/dashboard/pages.deleted.json so seeding and the rock
// inbox sync do not resurrect it.
//
// Output contract (read by the app): one line, `OK: page <id> deleted.` or
// `ERROR: ...`. Exit 0 on OK, 1 on ERROR.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export function deletePage(box, id) {
  id = String(id || '');
  if (!ID_RE.test(id) || id.includes('..')) return { ok: false, msg: 'ERROR: page id must be a plain slug.' };
  const dash = path.join(path.resolve(box), 'dashboard');
  const file = path.join(dash, 'pages', id + '.html');
  const mf = path.join(dash, 'pages.json');
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch { manifest = null; }
  const pages = manifest && Array.isArray(manifest.pages) ? manifest.pages : [];
  const inManifest = pages.some((p) => p && p.id === id);
  const onDisk = existsSync(file);
  if (!inManifest && !onDisk) return { ok: false, msg: `ERROR: no page called ${id} on this mineral.` };
  if (onDisk) unlinkSync(file);
  if (inManifest) {
    manifest.pages = pages.filter((p) => !(p && p.id === id));
    writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
  }
  // Tombstone, so the seeder (which the app runs on every pages-list) and the
  // rock inbox sync do not put the page straight back. A member who wants an
  // example page again asks their assistant, which drops the id from here.
  const tomb = path.join(dash, 'pages.deleted.json');
  let list = [];
  try { const t = JSON.parse(readFileSync(tomb, 'utf8')); list = Array.isArray(t) ? t.map(String) : []; } catch { list = []; }
  if (!list.includes(id)) { list.push(id); writeFileSync(tomb, JSON.stringify(list, null, 2) + '\n'); }
  return { ok: true, msg: `OK: page ${id} deleted.` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [box, id] = process.argv.slice(2);
  if (!box || !id) { console.log('ERROR: usage: page-delete.mjs <boxDir> <id>'); process.exit(1); }
  const r = deletePage(box, id);
  console.log(r.msg);
  process.exit(r.ok ? 0 : 1);
}
