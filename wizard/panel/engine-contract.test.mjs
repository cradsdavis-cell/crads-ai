// engine-contract.test.mjs: the app may only name engine files that exist.
//
// The app composes shell for the box to run, so `/app/engine/<x>` inside a
// command string is a call into a DIFFERENT artefact on a DIFFERENT release
// cadence. Nothing checked those names, and on 2026-08-11 that cost a day:
// dd96bd8 renamed engine/cockpit/client-cockpit.mjs to box-cockpit.mjs with no
// shim, the app was rebuilt against the new name within hours, and :v2 stayed at
// 2872ea5, which has only the old one. Every dashboard rebuild on every live
// mineral died module-not-found, data.json was never written, and both faces
// quietly served their empty state. It was reported as a rock brain_root bug
// because the fallback copy on an empty rock reads "your assistant".
//
// Two rules, and they cover the two directions the skew can go:
//   AUTHOR TIME  a path the app names must exist in this tree, so a rename that
//                forgets the app fails here instead of in the field.
//   RUN TIME     the dashboard rebuild, which is the one that bit us, resolves
//                its generator at runtime and falls back to the old name, so an
//                app running ahead of an un-promoted image still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const sources = readdirSync(HERE)
  .filter((f) => (f.endsWith('.mjs') || f.endsWith('.html')) && !f.includes('.test.'))
  .map((f) => ({ f, text: readFileSync(path.join(HERE, f), 'utf8') }));

// Names that are SUPPOSED to be absent here: deliberate fallbacks to a
// pre-rename file that only live images still carry. Each one is a promise to
// delete it once no supported image ships the old name, so the list must stay
// short and every entry must say when it can go.
const LEGACY_FALLBACKS = new Set([
  // dd96bd8 renamed it; droppable once every supported image is past 2872ea5.
  'engine/cockpit/client-cockpit.mjs',
]);

test('every /app/engine path the app names exists in this tree', () => {
  const missing = [];
  for (const { f, text } of sources) {
    for (const m of text.matchAll(/\/app\/(engine\/[A-Za-z0-9._\/-]+\.(?:mjs|js|sh))/g)) {
      if (LEGACY_FALLBACKS.has(m[1])) continue;
      if (!existsSync(path.join(ROOT, m[1]))) missing.push(`${f} -> /app/${m[1]}`);
    }
  }
  assert.deepEqual(missing, [],
    'the app is calling engine files that do not exist. Rename the call sites with the file, '
    + 'and give the runtime a fallback if live images still carry the old name.');
});

test('the dashboard rebuild resolves its generator at runtime, old name included', () => {
  // This is the specific call that broke, so it is pinned specifically: an image
  // is always allowed to be older than the app, and this one command is the one
  // every dashboard read depends on.
  const server = readFileSync(path.join(HERE, 'panel-server.mjs'), 'utf8');
  const gen = server.match(/GEN=\/app\/engine\/cockpit\/box-cockpit\.mjs;[^\n]*/);
  assert.ok(gen, 'the rebuild picks its generator into $GEN');
  assert.match(gen[0], /\[ -f "\$GEN" \] \|\| GEN=\/app\/engine\/cockpit\/client-cockpit\.mjs/,
    'and falls back to the pre-rename name that live images still ship');
  assert.match(server, /node "\$GEN" \/state/, 'and runs whichever it resolved');
});
