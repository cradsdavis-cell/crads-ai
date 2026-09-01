#!/usr/bin/env node
// edges-reflect.mjs — reflect this org's membership EDGES to the directory (D58 P5, spec § 5).
// "Every state change is executed by a managing box against its own registry; the directory
// only reflects it." This walks registry/members/*.yaml and POSTs one edge per member to
// /edges-reflect, authenticated by ORG_PULL_TOKEN (a rock may only write edges for its own
// org). The directory keys edges by sha256(email) and stores POINTERS ONLY. A `left` member
// reflects status=left, which prunes the edge. Dormant without a pull token; fail-silent.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const PULL_TOKEN = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN;
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim();

if (!PULL_TOKEN || !ORG) {
  console.log('edges-reflect: dormant (needs ORG_PULL_TOKEN + org handle).');
  process.exit(0);
}

const yq = (text, key) => (text.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm')) || [])[1]?.trim() ?? '';
// box.host lives under the nested `box:` block (2-space indent).
const boxHost = (text) => (text.match(/^box:\s*\n(?:[^\S\n].*\n)*?\s{2}host:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() ?? '';

const membersDir = path.join(repoRoot, 'registry', 'members');
let files = [];
try { files = (await readdir(membersDir)).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')); } catch { files = []; }

const reflect = async (body) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`${DIRECTORY_URL}/edges-reflect`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PULL_TOKEN}` },
      body: JSON.stringify(body),
    });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
};

let reflected = 0;
for (const f of files) {
  const text = await readFile(path.join(membersDir, f), 'utf8').catch(() => '');
  const slug = yq(text, 'slug');
  const email = yq(text, 'email');
  if (!slug || !email) continue;   // no identity to key an edge on
  const status = yq(text, 'status') || 'active';
  // D60 O3: mirror the row's owner (member|org) onto the edge. Optional by design:
  // rows without a valid value (pre-O1 stamps) reflect no owner at all, and the
  // operator edges below never carry one (they are not owned by any member box).
  const owner = yq(text, 'owner');
  // T1.3: mirror the box's structural kind (tier=rock|pebble) and the edge
  // relationship onto the edge. A member row's anchor edge to THIS org is
  // 'anchor' when this org is the row's anchor, else 'community'. Both optional,
  // additive: pre-pointer rows carry no tier and reflect no rel.
  const tier = yq(text, 'tier');
  const rel = yq(text, 'anchor') === ORG || !yq(text, 'anchor') ? 'anchor' : 'community';
  // Pause honesty (2026-08-03): a paused row's reason + date ride the edge so
  // the person's own screen can say who shut the door and why. Bounded here
  // AND at the directory; only ever sent for a paused row.
  const pausedReason = status === 'paused' ? String(yq(text, 'paused_reason') || '').slice(0, 160) : '';
  // the date lives nested under key_dates: (2-space indent), like box.host
  const pausedAt = status === 'paused'
    ? ((text.match(/^key_dates:\s*\n(?:[^\S\n].*\n)*?\s{2}paused:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() ?? '')
    : '';
  const ok = await reflect({ org: ORG, email, box_host: boxHost(text), role: 'member', status, slug,
    ...(owner === 'member' || owner === 'org' ? { owner } : {}),
    ...(tier === 'rock' || tier === 'pebble' ? { tier } : {}),
    ...(rel === 'anchor' || rel === 'community' ? { rel } : {}),
    ...(pausedReason ? { paused_reason: pausedReason } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(pausedAt) ? { paused: pausedAt } : {}) });
  if (ok) reflected += 1;
}

// D58 P5.6 (promote / hybrid): an org's OPERATORS get admin/support edges too, so a person
// who is a member of one org and runs their OWN org shows up as admin there. Emails come from
// org-policy.yaml admins:/support: (inline `[a, b]` or block `- a` list). This is what makes
// "promote member -> org" fall out: the new rock reflects an admin edge for its operator.
function emailList(section) {
  const inline = policy.match(new RegExp(`^\\s*${section}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (inline) return inline[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const block = policy.match(new RegExp(`^\\s*${section}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, 'm'));
  if (block) return block[1].split('\n').map((l) => (l.match(/-\s*["']?([^"'\n#]+)/) || [])[1]?.trim()).filter(Boolean);
  return [];
}
const rockHost = boxHost(policy) || '';
for (const role of ['admin', 'support']) {
  for (const email of emailList(role === 'admin' ? 'admins' : 'support')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) continue;   // skip placeholders like admin@org.test if malformed
    const ok = await reflect({ org: ORG, email, box_host: rockHost, role, status: 'active', slug: '' });
    if (ok) reflected += 1;
  }
}
console.log(`edges-reflect: reflected ${reflected} edge(s) for ${ORG} (members + operators).`);
