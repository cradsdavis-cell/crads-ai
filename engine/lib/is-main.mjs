// is-main.mjs: "am I the script node was asked to run?" for modules that carry
// a CLI tail below their exports (page-delete.mjs, skills-list.mjs).
//
// WHY (2026-09-11, the mac app that exited before main()): the desktop app
// bundles engine modules with esbuild and ships them as a single executable
// (node:sea). Inside that binary process.argv[1] IS the binary, and esbuild
// rewrites every module's import.meta.url to the binary's own file URL, so
// the usual guard `resolve(argv[1]) === fileURLToPath(import.meta.url)` is
// TRUE for every bundled module at import time. page-delete.mjs printed its
// usage line and called process.exit(1) before app.mjs's main() ever ran. On
// Windows the same guard stayed false by accident (new URL(...).pathname keeps
// a leading slash before the drive letter, so the two paths never met), which
// is why only the mac build died, with an empty stderr.
//
// The tell is argv[1] === execPath: `node script.mjs` never has that, a single
// executable always does. Refuse that first, then compare real paths, so a
// symlinked checkout (or /app on a box) still counts as "the script".
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

export function isMain(metaUrl, { argv1 = process.argv[1], execPath = process.execPath } = {}) {
  if (!argv1) return false;
  const entry = resolve(argv1);
  if (entry === resolve(execPath)) return false;        // a single executable: every module "is" argv[1]
  let me;
  try { me = fileURLToPath(metaUrl); } catch { return false; }
  return real(entry) === real(me);
}
