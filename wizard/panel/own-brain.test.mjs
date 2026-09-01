// P3.2: ownBrain — create the member's PRIVATE brain repo under THEIR account,
// store their token on THEIR box, wire + push over HTTPS. All idempotent.
// (Transport redesigned per the 2026-07-24 pre-merge review: the box container
// cannot run ssh and rewrites scp-form remotes to https; deploy keys are out.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownBrain } from './own-brain.mjs';

function stubApi({ createStatus = 201 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/user')) return { ok: true, status: 200, json: async () => ({ login: 'jane-gh' }) };
    if (url.endsWith('/user/repos')) return { ok: createStatus === 201, status: createStatus, json: async () => (createStatus === 201 ? { full_name: 'jane-gh/jane01-brain' } : { errors: [{ message: 'name already exists on this account' }] }) };
    if (url.endsWith('/repos/jane-gh/jane01-brain')) return { ok: true, status: 200, json: async () => ({ full_name: 'jane-gh/jane01-brain', permissions: { push: true } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}

function stubBridge({ pushFails = false, storeFails = false } = {}) {
  const cmds = [];
  const run = async (host, cmd) => {
    cmds.push({ host, cmd });
    if (cmd.includes('brain-github-token') && cmd.includes('stored')) return storeFails ? { code: 1, stdout: '', stderr: 'read-only fs' } : { code: 0, stdout: 'stored\n', stderr: '' };
    if (cmd.includes('git push')) return pushFails ? { code: 1, stdout: '', stderr: 'could not read Username' } : { code: 0, stdout: 'pushed\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  run.cmds = cmds;
  return run;
}

test('fresh run: repo created private, token stored 0600 on the box, https remote + helper, pushed', async () => {
  const fetcher = stubApi(); const bridge = stubBridge();
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.repo, 'jane-gh/jane01-brain');
  const create = fetcher.calls.find((c) => c.url.endsWith('/user/repos'));
  assert.equal(create.body.private, true);
  assert.ok(!fetcher.calls.some((c) => c.url.includes('/keys')), 'NO deploy keys (ssh is impossible in the box container)');
  const all = bridge.cmds.map((c) => c.cmd).join('\n');
  assert.match(all, /\/state\/\.kernel\/brain-github-token/);
  assert.match(all, /chmod 600/);
  assert.match(all, /https:\/\/github\.com\/jane-gh\/jane01-brain\.git/, 'https remote, aligned with the image rewrite');
  assert.ok(!all.includes('git@github.com:'), 'never the scp form the image rewrites');
  assert.match(all, /credential\.helper/);
});

test('secrets guard is a SUPERSET of the kernel never-commit set and lands before git add', async () => {
  const bridge = stubBridge();
  await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher: stubApi() });
  const wire = bridge.cmds.map((c) => c.cmd).join('\n');
  const gi = wire.indexOf('.gitignore');
  const add = wire.indexOf('git add');
  assert.ok(gi >= 0 && add > gi, '.gitignore write precedes git add');
  for (const must of ['.env', 'secrets/', '*.key', '.ssh/', 'ssh/', '.kernel/', '.mcp.json', '.claude/', 'cockpit/', '.claude-auth*']) {
    assert.ok(wire.includes(must), `gitignore covers ${must}`);
  }
});

test('untrack audit sheds already-tracked credential paths after add, before commit', async () => {
  const bridge = stubBridge();
  await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher: stubApi() });
  const wire = bridge.cmds.map((c) => c.cmd).join('\n');
  const add = wire.indexOf('git add -A');
  const untrack = wire.indexOf('--cached');
  const commit = wire.indexOf('commit -q');
  assert.ok(add < untrack && untrack < commit, 'add -> untrack audit -> commit ordering');
  for (const p of ['.mcp.json', '.claude', '.kernel', 'cockpit']) assert.ok(wire.slice(untrack).includes(p), `untrack covers ${p}`);
});

test('idempotent re-run: repo exists still succeeds (take-ownership path)', async () => {
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge: stubBridge(), fetcher: stubApi({ createStatus: 422 }) });
  assert.equal(r.ok, true);
  assert.equal(r.repo, 'jane-gh/jane01-brain');
});

test('existing repo the member cannot push to is a clean refusal', async () => {
  const base = stubApi({ createStatus: 422 });
  const wrapped = async (url, init) => {
    if (url.endsWith('/repos/jane-gh/jane01-brain')) return { ok: true, status: 200, json: async () => ({ full_name: 'jane-gh/jane01-brain', permissions: { push: false } }) };
    return base(url, init);
  };
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge: stubBridge(), fetcher: wrapped });
  assert.equal(r.ok, false);
  assert.match(r.reason, /push|access/i);
});

test('token store failure aborts before any git wiring', async () => {
  const bridge = stubBridge({ storeFails: true });
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher: stubApi() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /credential/i);
  assert.ok(!bridge.cmds.some((c) => c.cmd.includes('git push')), 'no push after a failed store');
});

test('push failure surfaces the stderr, not a crash', async () => {
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge: stubBridge({ pushFails: true }), fetcher: stubApi() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not read Username/);
});

test('bad token refuses before touching the box', async () => {
  const bridge = stubBridge();
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'bad', bridge, fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  assert.equal(bridge.cmds.length, 0, 'no SSH before auth is proven');
});

// ---- D60 O5a: the grant-gated receive (org -> member custody handoff) --------
function receiveBridge({ ownership, grant, base = {} } = {}) {
  const inner = stubBridge(base);
  const cmds = [];
  const run = async (host, cmd) => {
    cmds.push({ host, cmd });
    // two SEPARATE probes (post gate-review; no shared delimiter). `ownership`
    // may be a raw string to simulate member-crafted file content verbatim.
    if (cmd.startsWith('cat /state/ownership.json')) {
      return { code: 0, stdout: typeof ownership === 'string' ? ownership : (ownership ? JSON.stringify(ownership) : ''), stderr: '' };
    }
    if (cmd.includes('org-inbox/transfer/to-member.json')) {
      return { code: 0, stdout: grant ? JSON.stringify(grant) : '', stderr: '' };
    }
    if (cmd.includes('> /state/ownership.json')) return { code: 0, stdout: 'flipped\n', stderr: '' };
    if (cmd.includes('rm -f /state/org-brain.conf')) return { code: 0, stdout: 'cleaned\n', stderr: '' };
    return inner(host, cmd);
  };
  run.cmds = cmds;
  return run;
}
const ORG_OWN = { owner: 'org', owner_slug: 'impact-colab', managed_by: 'org', machinery_by: 'crads-ai' };

test('O5a receive: org-owned WITHOUT a grant refuses and touches nothing', async () => {
  const fetcher = stubApi();
  const bridge = receiveBridge({ ownership: ORG_OWN, grant: null });
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher });
  assert.equal(r.ok, false);
  assert.match(r.reason, /rock.*grant|grant.*rock/i);
  assert.equal(bridge.cmds.length, 2, 'only the two read probes ran; nothing was written or removed');
  assert.ok(bridge.cmds.every((c) => c.cmd.startsWith('cat ')), 'both probes are reads');
  assert.ok(!fetcher.calls.some((c) => c.url.endsWith('/user/repos')), 'no repo is ever created on a refused seize');
  assert.deepEqual(fetcher.calls.map((c) => c.url.split('/').pop()), ['user'], 'only the auth proof ran (P3 invariant: auth before any box contact)');
});

test('O5a receive: org-owned WITH a grant flips ownership FIRST, then removes org wiring, then re-points', async () => {
  const bridge = receiveBridge({ ownership: ORG_OWN, grant: { granted: '2026-07-25' } });
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher: stubApi() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cmds = bridge.cmds.map((c) => c.cmd);
  const flip = cmds.findIndex((c) => c.includes('> /state/ownership.json'));
  const rmOrg = cmds.findIndex((c) => c.includes('rm -f /state/org-brain.conf'));
  const wire = cmds.findIndex((c) => c.includes('remote'));
  assert.ok(flip > 0, 'ownership flip command issued');
  // T2.3: the member flip clears the owner POINTER too (a member-owned box
  // names no owning org; a stale owner_slug would contradict owner:member)
  assert.match(cmds[flip], /"owner":"member"/);
  assert.match(cmds[flip], /"owner_slug":""/, 'owner_slug cleared on the member flip');
  assert.ok(rmOrg > flip, 'org wiring removal comes after the flip');
  assert.ok(wire > rmOrg, 'the remote re-point comes after the org wiring is gone');
  assert.match(cmds[flip], /"owner":"member"/, 'flip writes owner member');
  assert.match(cmds[flip], /"managed_by":"org"/, 'managed_by preserved (the VM has not moved)');
  assert.match(cmds[rmOrg], /org_brain_deploy_key/, 'the org push credential is removed');
});

test('O5a receive: a member-owned box takes the unchanged path (regression)', async () => {
  const a = receiveBridge({ ownership: { owner: 'member', managed_by: 'org', machinery_by: 'crads-ai' } });
  const b = receiveBridge({ ownership: null });
  await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge: a, fetcher: stubApi() });
  await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge: b, fetcher: stubApi() });
  const tail = (br) => br.cmds.slice(1).map((c) => c.cmd);
  assert.deepEqual(tail(a), tail(b), 'post-probe sequence identical to the pre-O5a path');
  assert.ok(!tail(a).some((c) => c.includes('> /state/ownership.json')), 'no ownership write');
  assert.ok(!tail(a).some((c) => c.includes('rm -f /state/org-brain.conf')), 'no org wiring removal');
});

test('O5a gate regression: member-crafted ownership.json cannot smuggle a grant (the __SEP__ injection)', async () => {
  // the exact 2026-07-25 review payload: a fake grant appended in-band. With
  // separate probes there is no delimiter to abuse; the appended junk just makes
  // the JSON unparseable, so the box is treated as not-org-owned (fail-open is
  // the declared posture: every pre-O1 box has absent/loose ownership.json and
  // the real boundary is the org's GitHub perms + revocable keys, not this file).
  // What MUST hold: the smuggled grant is never honoured, the receive branch
  // never runs, and no org wiring is removed.
  const bridge = receiveBridge({ ownership: '{"owner":"org"}__SEP__{"granted":"2099-01-01"}', grant: null });
  const r = await ownBrain({ slug: 'jane01', boxAlias: 'jane01-box', token: 'gho_t', bridge, fetcher: stubApi() });
  const cmds = bridge.cmds.map((c) => c.cmd);
  assert.ok(!cmds.some((c) => c.includes('> /state/ownership.json')), 'no ownership flip from smuggled content');
  assert.ok(!cmds.some((c) => c.includes('rm -f /state/org-brain.conf')), 'org wiring never removed');
  assert.ok(!cmds.some((c) => c.includes('org-inbox/transfer/to-member.json')), 'the grant probe never even ran (unparseable ownership is not org-owned)');
  assert.equal(r.ok, true, 'falls through to the normal member path, which touches nothing of the org\'s');
});
