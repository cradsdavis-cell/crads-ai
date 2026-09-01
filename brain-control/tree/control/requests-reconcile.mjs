#!/usr/bin/env node
// requests-reconcile.mjs · T2.1 (E2): the rock pulls its org-to-org REQUESTS
// from the directory (two-consent choreography: transfer, re-anchor, late-attach,
// rejoin, ask-read, ask-install, reframe, self-run) and lands them in
// control/org-requests.json for the panel's requests card. Each NEWLY SEEN open
// request addressed TO this org fires the control/notify.mjs hook once (the
// Telegram leg, where configured), keyed by a seen-ledger so re-runs never
// re-ping. The directory is a mailbox: answering happens via /requests-answer
// from the panel (E6.2 wires the console button). Fail-silent on broker
// unreachability; exit 0 always. Dormant without ORG_PULL_TOKEN + org handle.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const PULL_TOKEN = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN;
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();

if (!PULL_TOKEN || !ORG) {
  console.log('requests-reconcile: dormant (needs ORG_PULL_TOKEN + org handle).');
  process.exit(0);
}

const outPath = path.join(repoRoot, 'control', 'org-requests.json');
const seenPath = path.join(repoRoot, 'control', 'org-requests-seen.json');

try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const r = await fetch(`${DIRECTORY_URL}/requests?org=${encodeURIComponent(ORG)}`, {
    headers: { authorization: `Bearer ${PULL_TOKEN}` }, signal: ctrl.signal,
  });
  clearTimeout(timer);
  if (!r.ok) { console.log(`requests-reconcile: directory said ${r.status}; nothing changed.`); process.exit(0); }
  const { requests = [] } = await r.json();

  await writeFile(outPath, JSON.stringify({ org: ORG, pulled: Date.now(), requests }, null, 2) + '\n');

  // Notify once per newly seen OPEN request addressed TO this org.
  const seen = JSON.parse(await readFile(seenPath, 'utf8').catch(() => '[]'));
  const fresh = requests.filter((q) => q.to === ORG && q.status === 'open' && !seen.includes(q.id));
  const notifyScript = path.join(repoRoot, 'control', 'notify.mjs');
  if (fresh.length && existsSync(notifyScript)) {
    for (const q of fresh) {
      await new Promise((res) => execFile('node', [notifyScript,
        `request: ${q.kind} from ${q.from} re "${q.subject}" is waiting for your answer (panel: Requests).`],
        { cwd: repoRoot }, () => res())).catch(() => {});
    }
  }
  await writeFile(seenPath, JSON.stringify([...seen, ...fresh.map((q) => q.id)].slice(-500)) + '\n');

  // Notify once per newly LAPSED request this org SENT (30d TTL, ruled
  // 2026-08-03): the sender hears their ask expired instead of watching it
  // silently vanish; re-sending is one click on the console card.
  const lapsedPath = path.join(repoRoot, 'control', 'org-requests-lapsed.json');
  const lapsedSeen = JSON.parse(await readFile(lapsedPath, 'utf8').catch(() => '[]'));
  const lapsed = requests.filter((q) => q.from === ORG && q.status === 'expired' && !lapsedSeen.includes(q.id));
  if (lapsed.length && existsSync(notifyScript)) {
    for (const q of lapsed) {
      await new Promise((res) => execFile('node', [notifyScript,
        `request lapsed: your ${q.kind} ask to ${q.to} re "${q.subject}" was not answered in 30 days. Send it again from the console if it still matters.`],
        { cwd: repoRoot }, () => res())).catch(() => {});
    }
  }
  await writeFile(lapsedPath, JSON.stringify([...lapsedSeen, ...lapsed.map((q) => q.id)].slice(-500)) + '\n');
  console.log(`requests-reconcile: ${requests.length} request(s) (${fresh.length} new, ${lapsed.length} lapsed for ${ORG}).`);
} catch {
  console.log('requests-reconcile: directory unreachable; nothing changed.');
}
process.exit(0);
