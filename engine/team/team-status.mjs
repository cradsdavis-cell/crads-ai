#!/usr/bin/env node
// team-status.mjs <state>: one line the desktop app reads to decide whether to show
// the Team page, and what to put on it (Crads for teams, stage 2).
//   TEAM_STATUS {"team":false}                                     not in a team
//   TEAM_STATUS {"team":true,"role":"hub"|"member","company":..,"person":..,
//                "pending":N,"people":[..],"slack":{..},"last_merge":..}
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from '../lib/is-main.mjs';
import { listProposals } from './team-proposals.mjs';
import { status as slackStatus } from './team-slack.mjs';

export function teamStatus(stateDir) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(path.join(stateDir, 'org', 'config.json'), 'utf8')); } catch { return { team: false }; }
  if (!cfg || !cfg.company || !cfg.role) return { team: false };
  const brain = path.join(stateDir, 'org', 'brain');
  let lastMerge = null;
  try { lastMerge = execFileSync('git', ['-C', brain, 'log', '-1', '--format=%cI', '--grep=^hub:'], { stdio: 'pipe', encoding: 'utf8' }).trim() || null; } catch {}
  const out = { team: true, role: cfg.role, company: cfg.company, person: cfg.person || cfg.slug, last_merge: lastMerge };
  if (cfg.role === 'hub') {
    out.people = (cfg.members || []).map((m) => m.slug);
    try { out.pending = listProposals(stateDir).length; } catch { out.pending = 0; }
    out.slack = slackStatus(stateDir);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) { console.error('usage: team-status.mjs <state>'); process.exit(64); }
  process.stdout.write(`TEAM_STATUS ${JSON.stringify(teamStatus(stateDir))}\n`);
}
