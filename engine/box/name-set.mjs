#!/usr/bin/env node
// One name (ruling 2026-08-09): the box label and the assistant's name are one
// fact stored twice — /state/box-name (the display mirror old readers use) and
// profile.yaml identity.assistant_name (the canonical field onboarding and the
// boot greeting read). Every rename goes through HERE and writes both, so the
// two files cannot diverge again. Display name only: never the address, the
// SSH host or the keys.
//
//   node name-set.mjs <boxDir> <name>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const box = path.resolve(process.argv[2] || '');
// double quotes are stripped so the name cannot break its own YAML line;
// control characters are refused upstream (box-rename) and stripped here too
const name = String(process.argv[3] || '').replace(/"/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
if (!process.argv[2] || !name) { console.error('usage: name-set.mjs <boxDir> <name>'); process.exit(1); }

writeFileSync(path.join(box, 'box-name'), name);

const p = path.join(box, 'profile.yaml');
let t = ''; try { t = readFileSync(p, 'utf8'); } catch { /* a fresh box: the file is born here */ }
const line = `assistant_name: "${name}"`;
if (/assistant_name:/.test(t)) t = t.replace(/assistant_name:[^\n]*/, line);
else if (/^identity:/m.test(t)) t = t.replace(/^identity:.*$/m, (m) => m + '\n  ' + line);
else t += (t && !t.endsWith('\n') ? '\n' : '') + 'identity:\n  ' + line + '\n';
writeFileSync(p, t);
console.log(`OK: renamed to ${name}`);
