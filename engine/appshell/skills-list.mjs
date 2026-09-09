#!/usr/bin/env node
// skills-list.mjs <state-dir> — one JSON snapshot of every skill on this box, for
// the app's Skills system page (three-layer model: "skills" is a Layer-1 system
// page; spec docs/superpowers/specs/2026-08-04-skills-cadence-library-design.md).
//
// Enumerates /state/.claude/skills/*/, joins SKILL.md frontmatter, skill.yaml
// (org-pushed packages), .origin.json (provenance, written by org-sync.sh),
// the member's cadence.json and skill-runs.json, and classifies each skill's
// source. Read-only; emits a single "SKILLS_STATE {json}" line, the same
// prefix-line idiom as member-console-state.
//
// Source classification (first match wins):
//   org    — .origin.json present (rock recorded), or skill.yaml present
//            (legacy org install that predates the origin marker)
//   engine — id exists in the image's own /app/engine/skills catalog
//   seed   — one of the cloud-init seed skills stamped by the factory
//   member — everything else (authored on this box)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { lastRunBySkill, lastRunByJob } from '../lib/run-ledger.mjs';
import { resolveBrainRoot } from '../lib/brain-root.mjs';

// The engine's own skill catalog. Overridable for tests and for staged runs on
// boxes whose /app predates this file (same escape hatch as scheduler.mjs).
const ENGINE_SKILLS_DIR = process.env.AIOS_ENGINE_SKILLS_DIR || '/app/engine/skills';
// Seeded from pebble-template/skills/ before first boot — historically by the
// retired rock-side factory (stamp-pebble.sh), since 2026-08-17 by the Mountain
// build (provisioning/managed/pebble-seed.sh, one-build-path spec).
// Nothing on the box marks them, so the known set lives here.
const SEED_IDS = ['eod', 'pulse'];
export const CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export function listSkills(stateDir) {
  // The skills dir follows the brain root: a rock keeps its skills under
  // /state/brain/.claude/skills (boot-rock.sh), a pebble under /state.
  const base = path.join(resolveBrainRoot(stateDir), '.claude', 'skills');
  let engine = [];
  try { engine = readdirSync(ENGINE_SKILLS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); } catch {}
  let ids = [];
  try {
    ids = readdirSync(base)
      .filter((d) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(d) && existsSync(path.join(base, d, 'SKILL.md')))
      .sort();
  } catch {}

  const skills = ids.map((id) => {
    const md = read(path.join(base, id, 'SKILL.md'));
    const fm = (md.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    // trim BEFORE stripping quotes: an inline comment leaves trailing spaces,
    // and `"$` cannot see a close-quote through them
    const fmGet = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1] || '').replace(/#.*$/, '').trim().replace(/^"|"$/g, '').trim();
    // skill.yaml (org-pushed packages) and .origin.json (rock provenance)
    // stopped meaning anything on 2026-09-09: communities are gone, so a
    // skill is the engine's, a starter, or the member's own. A skill that
    // once arrived from a community reads as the member's, which is honest:
    // it is theirs now and nothing else will ever update it.
    let category = fmGet('category') || 'other';
    if (!CATEGORIES.includes(category)) category = 'other';

    let source = 'member';
    if (engine.includes(id)) source = 'engine';
    else if (SEED_IDS.includes(id)) source = 'seed';

    return {
      id,
      // The human name (2026-08-09 audit R6): the page leads with this and
      // wears the /id as a chip. Absent on old skills; the page de-kebabs.
      title: fmGet('title'),
      description: fmGet('description'),
      category,
      source,
    };
  });

  return {
    skills,
    cadence: readJson(path.join(stateDir, 'cockpit', 'cadence.json')) || {},
    runs: readJson(path.join(stateDir, 'cockpit', 'skill-runs.json')) || {},
    // Run-ledger joins (spec § 5): newest outcome per skill (status + one-line
    // summary, page-local) and per machinery job (the honest backup/update rows).
    last_runs: lastRunBySkill(stateDir),
    machinery_runs: lastRunByJob(stateDir),
    generated: new Date().toISOString(),
  };
}

// CLI: node skills-list.mjs <state-dir>
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '/state');
  console.log('SKILLS_STATE ' + JSON.stringify(listSkills(stateDir)));
}
