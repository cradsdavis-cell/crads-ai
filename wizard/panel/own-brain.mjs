// own-brain.mjs — make the member's brain repo THEIRS (D58 P3, spec § 3 + keystone 2).
//
// Given the member's GitHub token (device flow, or any injected source) and their SSH
// access to their own box, this: creates the PRIVATE `<slug>-brain` repo under THE
// MEMBER'S account, stores the member's token ON THEIR OWN BOX (gitignored /state/.kernel,
// 0600), and wires the brain root to push over HTTPS with a repo-local credential helper.
// Run again any time: every leg is idempotent, so this same function IS the
// take-ownership migration for existing boxes and the re-point step of a future move (P5).
//
// TRANSPORT (redesigned after the 2026-07-24 pre-merge review, both blockers):
//   - HTTPS + credential helper, NOT ssh deploy keys. The box container bakes a
//     system git rewrite of `git@github.com:` remotes to https:// (Dockerfile.base),
//     and its passwd-less uid cannot run the ssh client at all ("No user exists for
//     uid"). SSH transport is structurally impossible in there; HTTPS is native.
//   - The token is an OAuth-App user token: long-lived until revoked, member-owned,
//     living on the member-owned box. Revoking it (GitHub settings) is the off-switch.
//
// Sovereignty guard rails baked in:
//   - the repo is created private, under the member's login, never the org's
//   - the org/manager gets NOTHING here (opt-in support grants are P5)
//   - the protective .gitignore is a SUPERSET of the box kernel's never-commit set
//     (review finding: it must be self-sufficient, not depend on box-up having run),
//     it lands BEFORE any `git add`, and an untrack audit sweeps already-tracked
//     credential paths out of the index before every commit
//
// Injectable: bridge (host, cmd) -> {code, stdout, stderr}; fetcher; log.

const API = 'https://api.github.com';

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Superset of engine/kernel/kernel.mjs IGNORE + box-up.sh's boot set + our own additions.
// Self-sufficient by design: own-brain must protect the brain root even on a box where
// the kernel's best-effort ignore pass never ran.
const IGNORES = ['.env', '.env.*', 'secrets/', '*.key', '*.pem', '.ssh/', 'ssh/', '.claude-auth/', '.claude-auth*', '.opencode-auth/', 'node_modules/', '.kernel/', '.mcp.json', '.claude/', 'cockpit/'];
// Paths force-removed from the index before every commit: gitignore cannot untrack, so a
// repo that ever tracked one of these must shed it before the next push.
const UNTRACK = ['.env', '.mcp.json', '.claude', '.claude-auth', '.opencode-auth', '.kernel', 'cockpit', 'secrets', 'ssh', '.ssh'];

const TOKEN_PATH = '/state/.kernel/brain-github-token';

export async function ownBrain({ slug, boxAlias, token, bridge, fetcher = fetch, log = () => {} } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(String(slug || ''))) return { ok: false, reason: 'bad slug' };
  if (!boxAlias || !token || !bridge) return { ok: false, reason: 'missing boxAlias, token, or bridge' };
  const gh = async (path, init = {}) => {
    const r = await fetcher(API + path, {
      ...init,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  };

  // 1. Whose account is this? (Also proves the token before we touch the box:
  //    the P3 invariant "no SSH before auth is proven" holds unchanged.)
  const me = await gh('/user');
  if (!me.ok || !me.body?.login) return { ok: false, reason: `GitHub sign-in not accepted (HTTP ${me.status})` };
  const login = me.body.login;
  const repoName = `${slug}-brain`;
  const repoPath = `${login}/${repoName}`;
  log(`signed in as ${login}`);

  // 1.5 D60 O5a receive gate. An ORG-owned box hands custody to the member only
  //     with the rock's grant (transfer/to-member.json, delivered down
  //     the inbox and pulled by org-sync). Two SEPARATE probes, no shared
  //     delimiter: the 2026-07-25 gate review proved a combined probe let
  //     member-crafted ownership.json smuggle a fake grant through an in-band
  //     __SEP__ split. HONEST SCOPE (stated in the plan): /state is the member's
  //     box, so this gate is a consent/correctness guard against accidental or
  //     undirected custody flips, NOT the security boundary. The boundary that
  //     holds against a hostile member is elsewhere and survives any bypass
  //     here: the rock's repo lives under the rock's GitHub,
  //     and its deploy key + the member's door keys are org-revocable.
  const ownProbe = await bridge(boxAlias, 'cat /state/ownership.json 2>/dev/null');
  let ownRec = null; try { ownRec = JSON.parse(String(ownProbe.stdout || '')); } catch { ownRec = null; }
  const orgOwned = !!ownRec && ownRec.owner === 'org';
  let grant = null;
  if (orgOwned) {
    const grantProbe = await bridge(boxAlias, 'cat /state/org-inbox/transfer/to-member.json 2>/dev/null');
    try { grant = JSON.parse(String(grantProbe.stdout || '')); } catch { grant = null; }
    if (!(grant && grant.granted)) {
      return { ok: false, reason: 'this box\'s brain belongs to the rock. Ask them to grant the transfer (they run transfer-to-member); once granted, run this again.' };
    }
  }

  // 2. Create the PRIVATE repo under the member's account; tolerate already-exists,
  //    but only if the member can actually push to it.
  const create = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name: repoName, private: true, description: `${slug}'s brain — owned by ${login}` }) });
  if (create.ok) log(`created private repo ${repoPath}`);
  else {
    const check = await gh(`/repos/${repoPath}`);
    if (!check.ok) return { ok: false, reason: `could not create ${repoPath} (HTTP ${create.status}) and it is not readable either` };
    if (check.body?.permissions && check.body.permissions.push === false) return { ok: false, reason: `${repoPath} exists but this account has no push access to it` };
    log(`repo ${repoPath} already exists; continuing (take-ownership / re-run)`);
  }

  // 3. Store the member's token ON THEIR OWN BOX: /state persists across container
  //    recreation (everything else is ephemeral), .kernel/ is gitignored, mode 0600.
  const store = await bridge(boxAlias,
    `mkdir -p /state/.kernel && umask 077 && printf %s ${sq(token)} > ${TOKEN_PATH} && chmod 600 ${TOKEN_PATH} && echo stored`);
  if (store.code !== 0 || !/stored/.test(String(store.stdout || ''))) return { ok: false, reason: `the box could not store its brain credential: ${(store.stderr || '').trim()}` };
  log('brain credential stored on the box (yours, revocable from GitHub settings)');

  // 3.5 D60 O5a receive (granted org-owned box only), ORDER IS LOAD-BEARING:
  //     flip ownership.json to member FIRST (this disarms org-brain-wire's guard,
  //     so the org-sync cadence can no longer re-init custody back to the org),
  //     THEN remove the org wiring + push credential, THEN re-point below. The
  //     rock's repo itself is never touched: it keeps its copy.
  if (orgOwned) {
    log('org-owned box with a transfer grant: taking ownership (the rock keeps its copy)');
    // T2.3: clear the owner pointer with the flip (member-owned carries no org slug)
    const flipped = JSON.stringify({ ...ownRec, owner: 'member', owner_slug: '' });
    const flip = await bridge(boxAlias, `printf %s ${sq(flipped + '\n')} > /state/ownership.json && echo flipped`);
    if (flip.code !== 0 || !/flipped/.test(String(flip.stdout || ''))) return { ok: false, reason: `the box could not record the ownership change: ${(flip.stderr || '').trim()}` };
    const clean = await bridge(boxAlias, 'rm -f /state/org-brain.conf /state/secrets/org_brain_deploy_key && echo cleaned');
    if (clean.code !== 0) return { ok: false, reason: `the box could not remove the rock wiring: ${(clean.stderr || '').trim()}` };
    log('ownership recorded as yours; the rock\'s push wiring is removed');
  }

  // 4. Wire the brain root and push over HTTPS. Protective .gitignore BEFORE any add,
  //    untrack audit before the commit (see header).
  const igAppend = IGNORES.map((l) => `grep -qxF ${sq(l)} .gitignore 2>/dev/null || echo ${sq(l)} >> .gitignore`).join('; ');
  const helper = `!f() { echo username=x-access-token; echo "password=$(cat ${TOKEN_PATH})"; }; f`;
  const wire = await bridge(boxAlias, [
    'set -e',
    'if [ -d /state/brain ]; then BR=/state/brain; else BR=/state; fi',
    'cd "$BR"',
    igAppend,
    'git init -q 2>/dev/null || true',
    // https remote ALIGNS with the base image's insteadOf rewrite instead of fighting it
    `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${sq(`https://github.com/${repoPath}.git`)} || git remote add origin ${sq(`https://github.com/${repoPath}.git`)}`,
    `git config credential.helper ${sq(helper)}`,
    'git add -A',
    // untrack audit: shed credential paths a previous life may have tracked
    `git rm -r -q --cached --ignore-unmatch ${UNTRACK.join(' ')} 2>/dev/null || true`,
    `git -c user.name=${sq(slug)} -c user.email=${sq(`${slug}@box.local`)} commit -q -m "own-brain: snapshot" 2>/dev/null || true`,
    'git push -q -u origin HEAD 2>&1',
  ].join('; '),
  // This is the ONE bulk call in the flow: it stages the whole brain, commits it and
  // pushes a brand-new repo over the box's uplink. The bridge's default watchdog is
  // 25s, sized for one-line verbs, and it SIGKILLs the local client on overrun while
  // the box-side connection ages out on its own. Repeat that a few times and the
  // lingering half-open connections are exactly the MaxStartups saturation that makes
  // the next attempt die with "Connection reset by <ip> port 22" (2026-08-05).
  { hardTimeoutMs: Number(process.env.AIOS_OWN_BRAIN_PUSH_MS || 600000) });
  if (wire.code !== 0) {
    const detail = (wire.stderr || wire.stdout || '').trim();
    // Name the leg honestly. A reset, timeout or refused hop never reached git at all,
    // so calling it "brain push failed" sends the member to GitHub looking for a fault
    // that is in the transport. Same class as the door reporting 2% for a request no
    // builder had touched.
    const transport = /Connection (reset|closed|refused|timed out)|kex_exchange|Broken pipe|exceeded \d+ms|No route to host|Host key verification|Permission denied \(publickey/i.test(detail);
    return { ok: false, reason: transport
      ? `could not reach your box to make the copy (the repo and credential are already in place, so pressing Connect again resumes here): ${detail}`
      : `brain push failed: ${detail}` };
  }

  log(`brain pushed to ${repoPath}`);

  // Verified Complete (verb-interview ruling 2026-08-03): publish the acceptance
  // RECEIPT to the heartbeat repo, the one channel the box writes that the org
  // can read, mirroring transfer-accept's marker exactly. The org's
  // transfer-complete refuses until it sees this file, so the human step can no
  // longer be clicked early. Fail-soft on purpose: a box with no heartbeat
  // channel (self-sovereign, no org) has nobody waiting on a receipt.
  // Name the grant this answers. A receipt of {owned,repo,at} was REUSABLE: the
  // org's verifier only checked that it existed and recorded member ownership,
  // and nothing ever deletes it, so once a member had taken ownership once a
  // LATER transfer-to-member could complete on this same receipt with the member
  // doing nothing. `grant` is the org's to-member.json, already probed above.
  const receipt = JSON.stringify({
    owned: 'member', repo: repoPath, at: new Date().toISOString().slice(0, 10),
    granted: (grant && grant.granted) || '',
  });
  const pub = await bridge(boxAlias, [
    'if [ -f /state/heartbeat.conf ] && [ -f /state/secrets/heartbeat_deploy_key ] && [ -f /state/org-inbox.conf ]',
    'then set -e; . /state/org-inbox.conf',
    'W=/state/.own-receipt; rm -rf "$W"',
    'export GIT_SSH_COMMAND="ssh -i /state/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"',
    'git clone -q --depth 1 "${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}" "$W"',
    'mkdir -p "$W/transfer"',
    `printf %s ${sq(receipt + '\n')} > "$W/transfer/owned-by-member.json"`,
    'cd "$W"; git add transfer/owned-by-member.json',
    'git -c user.name=box -c user.email=box@box.local commit -q -m "own-brain: acceptance receipt" 2>/dev/null || true',
    'git push -q origin HEAD; rm -rf "$W"; echo receipt-published',
    'else echo no-heartbeat-channel; fi',
  ].join('\n'));
  if (/receipt-published/.test(String(pub.stdout || ''))) log('acceptance receipt published to the rock');
  else log('no rock channel to receipt (self-sovereign box, or the push will retry on the next accept)');

  return { ok: true, repo: repoPath, pushed: true };
}
