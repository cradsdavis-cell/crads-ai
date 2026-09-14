// app-bundle-guards.test.mjs: nothing the desktop app bundles may carry a
// module-level "am I the CLI entry" guard of its own.
//
// The class (2026-09-11, the mac app that exited 1 before main()): esbuild
// folds every module reachable from wizard/app.mjs into one file, and in the
// single executable that file IS process.argv[1]. A guard like
//   if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
// is then true for every bundled module at import time, and page-delete.mjs
// ran its usage-and-exit tail as the app booted. The unit suite never sees it
// (a test file is argv[1] there) and app-boot.test.mjs runs from source, so
// this walks the real import graph and refuses the pattern outright: a CLI
// tail goes through engine/lib/is-main.mjs, which knows about the binary.
// Run: node --test wizard/app-bundle-guards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./app.mjs', import.meta.url));
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const GUARD_RE = /^\s*if\s*\(.*(?:process\.argv\[1\]|import\.meta\.url\s*===)/m;

function walk(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec || !/\.(mjs|js|cjs)$/.test(spec)) continue;
    walk(resolve(dirname(file), spec), seen);
  }
  return seen;
}

test('no module bundled into the desktop app has its own argv[1] / import.meta.url entry guard', () => {
  const files = [...walk(ENTRY)];
  assert.ok(files.length > 40, `walked ${files.length} modules; the graph looks truncated`);
  assert.ok(files.some((f) => f.endsWith('/engine/appshell/page-delete.mjs')), 'the walk reaches the engine module that broke the mac build');
  const offenders = files.filter((f) => !f.endsWith('/engine/lib/is-main.mjs') && GUARD_RE.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'route these through isMain(import.meta.url) from engine/lib/is-main.mjs');
});
