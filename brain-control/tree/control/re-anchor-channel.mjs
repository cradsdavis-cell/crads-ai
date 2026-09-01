#!/usr/bin/env node
// re-anchor-channel.mjs · the CHANNEL SWAP choreography for a re-anchor
// (option c, ruled 2026-07-28). Runs on both rocks' reconcile cadence after
// re-anchor-reconcile has moved the registry row. Custody properties held
// throughout: the box's private key never travels; the OLD rock relays only a
// credential-free notice and the box's PUBLIC key; the NEW rock touches only
// its own repos. Message transport = the requests engine (subjects
// "<slug> channel" and "<slug> pubkey", payloads bounded + non-sensitive).
//
//   NEW rock (B): row landed        -> send {gh_owner} to the old rock
//   OLD rock (A): channel msg open  -> push notice + apply-script down its
//                                      still-open inbox; answer accepted
//   OLD rock (A): box published key -> read re-anchor/heartbeat_key.pub from
//                                      its own heartbeat repo; send {pubkey}
//   NEW rock (B): pubkey msg open   -> create heartbeat-<slug> (empty, main)
//                                      + register the key read-write; answer
// Every step idempotent via control/re-anchor-channel.json; fail-soft: a step
// that cannot complete retries next pass.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const E = (k) => process.env[k] || env[k] || '';
const DIRECTORY_URL = E('CRADS_DIRECTORY_URL') || 'https://directory.crads-ai.com';
const PULL_TOKEN = E('ORG_PULL_TOKEN');
// The shared resolver, so this path sees the account connected with
// connect-github like every other consumer does (it used to read two names and
// go quietly dormant on a door-born rock).
const { owner: GH_OWNER, token: GH_TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG || !PULL_TOKEN) { console.log('re-anchor-channel: dormant (needs org handle + ORG_PULL_TOKEN).'); process.exit(0); }

const post = async (p, body) => {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${DIRECTORY_URL}${p}`, { method: 'POST', signal: ctrl.signal,
      headers: { authorization: `Bearer ${PULL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    clearTimeout(t); return r.ok;
  } catch { return false; }
};
const gh = async (method, p, body) => {
  const r = await fetch(`https://api.github.com${p}`, { method,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'crads-reanchor' },
    body: body ? JSON.stringify(body) : undefined });
  return r;
};

const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
const reqs = inbox.requests || [];
const statePath = path.join(repoRoot, 'control', 're-anchor-channel.json');
const state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'));
const save = () => writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
const slugOf = (subject) => String(subject || '').split(' ')[0];

let acted = 0;

// ---- NEW rock: a landed re-anchor without a sent channel msg -> send it ----
for (const q of reqs.filter((x) => x.kind === 're-anchor' && x.status === 'accepted' && x.to === ORG && !/ (channel|pubkey)$/.test(x.subject))) {
  const slug = q.subject;
  const st = state[slug] = state[slug] || {};
  if (st.channel_sent || !GH_OWNER) continue;
  if (await post('/requests', { from_org: ORG, to_org: q.from, kind: 're-anchor', subject: `${slug} channel`, payload: { gh_owner: GH_OWNER } })) {
    st.channel_sent = true; acted++; console.log(`re-anchor-channel: sent channel details for ${slug} to ${q.from}.`);
  }
}

// ---- OLD rock: an open channel msg -> deliver notice + script; answer ----
for (const q of reqs.filter((x) => x.kind === 're-anchor' && x.status === 'open' && x.to === ORG && / channel$/.test(x.subject))) {
  const slug = slugOf(q.subject);
  if ((state[slug] || {}).notice_delivered) continue;   // answered-but-stale inbox snapshots must not re-deliver
  let pay = {}; try { pay = JSON.parse(q.payload || '{}'); } catch { /* shapeless */ }
  if (!pay.gh_owner) continue;
  const stage = path.join(repoRoot, 'state', 'reanchor-stage', slug);
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'notice.json'), JSON.stringify({ new_anchor: q.from, new_gh_owner: pay.gh_owner, date: new Date().toISOString().slice(0, 10) }) + '\n');
  await cp(path.join(repoRoot, 'pebble-template', 'box', 're-anchor-apply.sh'), path.join(stage, 're-anchor-apply.sh'));
  const ok = await new Promise((res) => execFile('node',
    [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, stage, 're-anchor'], { cwd: repoRoot }, (e) => res(!e)));
  if (!ok) { console.log(`re-anchor-channel: notice delivery to ${slug} failed; next pass.`); continue; }
  await post('/requests-answer', { org: ORG, id: q.id, answer: 'accepted', note: 'notice delivered; watching for the box key' });
  (state[slug] = state[slug] || {}).notice_delivered = true; acted++;
  console.log(`re-anchor-channel: notice + apply script delivered to ${slug}.`);
}

// ---- OLD rock: notice delivered -> watch for the box's published PUBLIC key ----
for (const [slug, st] of Object.entries(state)) {
  if (!st.notice_delivered || st.pubkey_sent) continue;
  const clone = path.join(repoRoot, 'state', 'heartbeats-in', slug);
  try {
    const remote = plainRemote(GH_OWNER, `heartbeat-${slug}`);
    if (existsSync(path.join(clone, '.git'))) execFileSync('git', ['-C', clone, 'pull', '--ff-only', 'origin', 'main'], { stdio: 'pipe' });
    else { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', '--depth', '1', remote, clone], { token: GH_TOKEN }); }
    const pub = (await readFile(path.join(clone, 're-anchor', 'heartbeat_key.pub'), 'utf8')).trim();
    const acc = JSON.parse(await readFile(path.join(clone, 're-anchor', 'accepted.json'), 'utf8'));
    if (pub && acc.new_anchor) {
      if (await post('/requests', { from_org: ORG, to_org: acc.new_anchor, kind: 're-anchor', subject: `${slug} pubkey`, payload: { pubkey: pub } })) {
        st.pubkey_sent = true; acted++; console.log(`re-anchor-channel: relayed ${slug}'s public key to ${acc.new_anchor}.`);
      }
    }
  } catch { /* not published yet; next pass */ }
}

// ---- NEW rock: an open pubkey msg -> heartbeat repo + key; answer ----
for (const q of reqs.filter((x) => x.kind === 're-anchor' && x.status === 'open' && x.to === ORG && / pubkey$/.test(x.subject))) {
  const slug = slugOf(q.subject);
  let pay = {}; try { pay = JSON.parse(q.payload || '{}'); } catch { /* shapeless */ }
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [^\s]{1,64})?$/.test(pay.pubkey || '')) { console.log(`re-anchor-channel: ${slug} pubkey msg malformed; leaving open.`); continue; }
  if (!GH_OWNER || !GH_TOKEN) continue;
  // repo: create if absent (empty init with main, the O2 pattern)
  const repo = `heartbeat-${slug}`;
  const exists = (await gh('GET', `/repos/${GH_OWNER}/${repo}`)).status === 200;
  if (!exists) {
    await gh('POST', '/user/repos', { name: repo, private: true, auto_init: true });
  }
  const reg = await gh('POST', `/repos/${GH_OWNER}/${repo}/keys`, { title: `${slug} heartbeat (re-anchor)`, key: pay.pubkey, read_only: false });
  if (reg.status !== 201 && reg.status !== 422) { console.log(`re-anchor-channel: key registration for ${slug} said ${reg.status}; next pass.`); continue; }
  await post('/requests-answer', { org: ORG, id: q.id, answer: 'accepted', note: 'heartbeat channel live on the new anchor' });
  acted++; console.log(`re-anchor-channel: ${slug}'s heartbeat channel is live here (repo + key).`);
}

await save();
console.log(`re-anchor-channel: ${acted} step(s) advanced.`);
