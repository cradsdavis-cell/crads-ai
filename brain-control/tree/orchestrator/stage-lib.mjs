#!/usr/bin/env node
// stage-lib.mjs: shared pack-staging helpers.
//
// stageDirs moved out of install-pack.mjs (delivery-model step 7c, Part A).
// install-pack.mjs is being deprecated (kept one more release as an operator
// escape hatch per Sam's ruling, then deleted), and stageDirs is a genuinely
// useful, independently-tested helper (tests/pack-dirs.test.mjs imports it),
// so it needed a home that outlives that file. install-pack.mjs re-exports it
// so nothing else that may import stageDirs from there today breaks.
import { cp } from 'node:fs/promises';
import path from 'node:path';

// Stage each pack dirs/<id>/ tree (and its optional <id>.yaml kind manifest)
// into a payload dir for push-down. Ids were validated by pack-lint before
// this runs; the belt here refuses anything unsafe anyway.
export async function stageDirs(packDir, ids, payload) {
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) continue;
    await cp(path.join(packDir, 'dirs', id), path.join(payload, id), { recursive: true });
    const kindManifest = path.join(packDir, 'dirs', `${id}.yaml`);
    try { await cp(kindManifest, path.join(payload, `${id}.yaml`)); } catch { /* optional */ }
  }
}
