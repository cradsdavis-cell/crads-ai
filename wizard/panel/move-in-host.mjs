// move-in-host.mjs: the app's half of a /move-in step that changes the server
// itself, and of "Move out" (spec 2026-10-17-adopt-existing-server.md § 3).
//
// THE SHAPE. The container holds the plan; the server holds the crontab and the
// services; only this app holds a key to the server. So a host step is three
// calls, and only the middle one touches the server:
//
//   1. container: apply.mjs host-begin <id> <apply|undo>
//        does the Crads-AI side that comes first and answers HOST_OP {op}
//   2. server:    ONE of the two allow-listed ops (engine/move-in/host-ops.mjs),
//        checked here with validateHostOp() before anything is sent. The box is
//        trusted to plan, never to say what runs: an op it cannot name in the
//        allow-list, or one carrying any extra field, is refused and the
//        container side is rolled back.
//   3. container: apply.mjs host-end <id> <apply|undo> <ok|fail>
//        records what happened, does the Crads-AI side that comes after, or puts
//        the first half back when the server said no.
//
// Nothing here takes a command, a path or a step body from the page: the page
// names a step id and a direction, panel-server checks both shapes, and every
// argument the server sees comes from the box's inventory through the allow-list.
//
// `container(args, stdin)` runs `node /app/engine/move-in/apply.mjs /state <args>`
// inside the mineral and resolves { code, stdout }. `host` has ssh(command,
// input, timeoutMs) -> { code, stdout, stderr }: an OwnServerClient
// (wizard/provision/own-server.mjs) in the app, a fake in the tests.
import {
  validateHostOp, AS_ROOT, cronReadScript, cronWriteScript, parseCrontabAnswer, cronEdit,
  unitScript, parseUnitAnswer, errOf, sha256, USER_RE, cronCheck, unitCheckScript, parseUnitState,
} from '../../engine/move-in/host-ops.mjs';
import { STEP_ID_RE } from '../../engine/move-in/lib.mjs';
import { teardownSharedHost } from '../provision/adopt-host.mjs';

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const tagged = (stdout, tag) => {
  const m = String(stdout || '').match(new RegExp(`^${tag} (.*)$`, 'm'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
const boxError = (r) => {
  const m = String((r && r.stdout) || '').match(/^ERROR: (.*)$/m);
  return m ? m[1] : `your mineral did not answer (exit ${r && r.code})`;
};

// The two ops, run over SSH. Resolves { ok, result?, error? }; never throws.
export async function runHostOp(host, op) {
  const bad = validateHostOp(op);
  if (bad) return { ok: false, error: bad };
  try {
    // the read-only forms: what the server shows, nothing written
    if (op.action === 'check') {
      if (op.op === 'cron-comment') {
        const read = await host.ssh(AS_ROOT, cronReadScript(op.user), 30_000);
        const text = read.code === 0 ? parseCrontabAnswer(read.stdout) : null;
        if (text == null) return { ok: false, error: `could not read the crontab: ${errOf(read)}` };
        return { ok: true, result: cronCheck(text, op.line_text, op.ymd) };
      }
      const r = await host.ssh(AS_ROOT, unitCheckScript(op), 30_000);
      const st = r.code === 0 ? parseUnitState(r.stdout) : null;
      if (!st) return { ok: false, error: `could not ask systemd: ${errOf(r)}` };
      return { ok: true, result: st };
    }
    if (op.op === 'cron-comment') {
      const read = await host.ssh(AS_ROOT, cronReadScript(op.user), 30_000);
      const text = read.code === 0 ? parseCrontabAnswer(read.stdout) : null;
      if (text == null) return { ok: false, error: `could not read the crontab: ${errOf(read)}` };
      const edit = cronEdit(op, text);
      if (!edit.ok) return { ok: false, error: edit.reason };
      const w = await host.ssh(AS_ROOT, cronWriteScript(op.user, sha256(text), edit.text), 30_000);
      const m = String(w.stdout || '').match(/^WROTE ([0-9a-f]{64})\s*$/m);
      if (w.code !== 0 || !m) return { ok: false, error: errOf(w) };
      const result = { ymd: op.ymd, line_no: edit.line_no };
      if (m[1] !== sha256(edit.text)) result.warning = 'the crontab now reads slightly differently from what was written (cron tidied it); check the line on the server';
      return { ok: true, result };
    }
    const r = await host.ssh(AS_ROOT, unitScript(op), 60_000);
    const a = parseUnitAnswer(r.stdout);
    if (r.code !== 0 || !a.done) return { ok: false, error: errOf(r) };
    return { ok: true, result: op.action === 'apply' ? { prior: a.prior || { enabled: 'unknown', active: 'unknown' } } : {} };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// One host step, both container halves included.
export async function runHostStep({ id, action, container, host }) {
  if (!STEP_ID_RE.test(String(id || ''))) return { ok: false, error: 'that is not a step id' };
  if (action !== 'apply' && action !== 'undo') return { ok: false, error: 'a server step is either done or undone' };
  const begin = await container(['host-begin', id, action]);
  const op = begin.code === 0 ? tagged(begin.stdout, 'HOST_OP') : null;
  if (!op) return { ok: false, error: boxError(begin) };
  const ran = await runHostOp(host, op);
  const end = await container(['host-end', id, action, ran.ok ? 'ok' : 'fail'], b64(ran.result || {}) + '\n');
  if (!ran.ok) return { ok: false, error: `${ran.error}. ${end.code === 0 ? 'Nothing was changed on your server, and the Crads-AI side was put back.' : boxError(end)}` };
  if (end.code !== 0) return { ok: false, error: `your server changed, but your mineral could not record it: ${boxError(end)}. Press the step again to finish it.` };
  return { ok: true, said: String(end.stdout || '').replace(/^OK: /m, '').trim(), warning: ran.result && ran.result.warning };
}

// ---- a step the app stopped half way through -----------------------------------------
// Both use only the step's own op: its read-only check form, then (resolve
// only) at most one apply or undo the box names, validated here like any other.

async function freshCheck(id, container, host) {
  const r = await container(['host-check', id]);
  const op = r.code === 0 ? tagged(r.stdout, 'HOST_OP') : null;
  if (!op) return { ok: false, error: boxError(r) };
  if (op.action !== 'check') return { ok: false, error: 'your mineral asked for a change where the app expected a check' };
  const seen = await runHostOp(host, op);
  return seen.ok ? { ok: true, check: seen.result } : seen;
}

// What the server really shows; recorded on the box so the page renders it.
export async function checkHostStep({ id, container, host }) {
  if (!STEP_ID_RE.test(String(id || ''))) return { ok: false, error: 'that is not a step id' };
  const seen = await freshCheck(id, container, host);
  if (!seen.ok) return seen;
  const rec = await container(['host-checked', id], b64(seen.check) + '\n');
  const out = rec.code === 0 ? tagged(rec.stdout, 'CHECK') : null;
  if (!out) return { ok: false, error: boxError(rec) };
  return { ok: true, check: out, said: out.words };
}

// Finish the interrupted move, or put it back: checks again first (the page's
// check may be stale), runs at most the one op the box names, then closes the
// step with host-end.
export async function resolveHostStep({ id, choice, container, host }) {
  if (!STEP_ID_RE.test(String(id || ''))) return { ok: false, error: 'that is not a step id' };
  if (choice !== 'finish' && choice !== 'rollback') return { ok: false, error: 'the way out is either finish or rollback' };
  const seen = await freshCheck(id, container, host);
  if (!seen.ok) return seen;
  const rr = await container(['host-resolve', id, choice], b64(seen.check) + '\n');
  const plan = rr.code === 0 ? tagged(rr.stdout, 'RESOLVE') : null;
  if (!plan) return { ok: false, error: boxError(rr) };
  const shown = await container(['show']);
  const st = shown.code === 0 ? tagged(shown.stdout, 'MOVEIN_STATE') : null;
  const step = st && st.plan && (st.plan.steps || []).find((x) => x.id === id);
  const action = step && step.in_flight;
  if (action !== 'apply' && action !== 'undo') return { ok: false, error: `${id} is no longer part-way through` };
  let result = plan.result && typeof plan.result === 'object' ? plan.result : {};
  if (plan.op) {
    if (plan.op.action !== 'apply' && plan.op.action !== 'undo') return { ok: false, error: 'your mineral named something the app will not run' };
    const ran = await runHostOp(host, plan.op);
    if (!ran.ok) return { ok: false, error: `${ran.error}. The step is still part-way through; check again.` };
    result = ran.result || {};
  }
  const end = await container(['host-end', id, action, plan.end === 'ok' ? 'ok' : 'fail'], b64(result) + '\n');
  if (end.code !== 0) return { ok: false, error: boxError(end) };
  return { ok: true, said: String(end.stdout || '').replace(/^OK: /m, '').trim() };
}

// The login the server steps run as: the one host setup recorded.
export async function serverLogin(container) {
  const r = await container(['show']);
  const st = r.code === 0 ? tagged(r.stdout, 'MOVEIN_STATE') : null;
  const login = st && st.plan && st.plan.login;
  return USER_RE.test(String(login || '')) ? { login, brainRoot: String(st.plan.brain_root || ''), state: st } : null;
}

// Move out: FIRST every committer on the mineral is held (move-out-begin writes
// moving_out and moving_in into ownership.json), then every done step is
// reversed, newest first (server steps over SSH, mineral steps in the
// container), and only then the host setup itself, last. Stops at the first
// step that will not reverse, before the teardown, so a half-reversed server is
// never also stripped of the thing that could finish it.
//
// Holding first is rehearsal T4 finding 1: box-up's exit trap commits on every
// container stop once the move-in is finished, and the teardown stops the
// container, so Move out after Finish left Crads-AI commits in the person's
// repo. Nothing rewrites history: the answer names, by sha and subject, the
// commits Crads-AI made before Move out, which stay, and what stays in the folder.
export async function moveOut({ container, host, teardown, brainRoot }) {
  const said = [];
  const begin = await container(['move-out-begin']);
  const held = begin.code === 0 ? tagged(begin.stdout, 'MOVEOUT_BEGIN') : null;
  if (!held) return { ok: false, error: `nothing was changed: your mineral could not hold its jobs and commits first (${boxError(begin)})`, said };
  let report = held;
  const left = (extra = {}) => ({ kept: report.kept || [], commits: report.commits || [], ...extra });
  const lr = await container(['move-out-list']);
  const list = lr.code === 0 ? tagged(lr.stdout, 'MOVEOUT') : null;
  if (!Array.isArray(list)) return { ok: false, error: boxError(lr), said, ...left() };
  for (const s of list) {
    if (!STEP_ID_RE.test(String(s.id || ''))) return { ok: false, error: 'the plan named a step the app does not recognise', said, ...left() };
    if (s.side === 'host') {
      const r = await runHostStep({ id: s.id, action: 'undo', container, host });
      if (!r.ok) return { ok: false, error: `${s.id} would not reverse: ${r.error}`, said, stopped_at: s.id, ...left() };
      said.push(`${s.id} reversed on your server`);
    } else {
      const r = await container(['undo', s.id]);
      if (r.code !== 0) return { ok: false, error: `${s.id} would not reverse: ${boxError(r)}`, said, stopped_at: s.id, ...left() };
      said.push(`${s.id} reversed on your mineral`);
    }
  }
  // the last word on what Crads-AI committed, read while the container still runs
  const last = await container(['move-out-report']);
  const rep = last.code === 0 ? tagged(last.stdout, 'MOVEOUT_REPORT') : null;
  if (rep) report = rep;
  // the host path the inventory recorded, never `~` (teardownSharedHost refuses anything else)
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(String(brainRoot || '')) || brainRoot === '/') {
    return { ok: false, error: 'every step was reversed, but the plan does not name your brain folder on the server, so the setup was left in place', said, reversed: true, ...left() };
  }
  let t;
  try {
    t = await teardown(host, { brainRoot });
  } catch (e) {
    return { ok: false, error: `every step was reversed, but taking the Crads-AI setup off your server failed: ${String((e && e.message) || e)}`, said, reversed: true, ...left() };
  }
  // the setup's own record of what it left in the folder on purpose (ownership.json, ...)
  const setupKept = t && Array.isArray(t.kept) ? t.kept.map(String) : [];
  // teardownSharedHost answers { ok, undone, kept, skipped, failed, recordRemoved }:
  // a not-ok result is said in words, never reported as moved out
  if (t && t.ok === false) {
    const list = (a) => (Array.isArray(a) && a.length ? a.map(String).join('; ') : '');
    const parts = [list(t.failed) && `could not undo: ${list(t.failed)}`, list(t.skipped) && `left for you to check: ${list(t.skipped)}`].filter(Boolean);
    return { ok: false, error: `every step was reversed, but part of the Crads-AI setup is still on your server (${parts.join('; ') || 'it did not say which part'}). Its record stays in your folder, so Move out can be run again`, said, reversed: true, teardown: t, ...left({ setup_kept: setupKept }) };
  }
  said.push('the Crads-AI setup is off your server');
  return { ok: true, said, ...left({ setup_kept: setupKept }) };
}

// What Move out leaves behind, in words for the page: the files that stay in
// the folder, and the commits Crads-AI made that stay in git history.
export function moveOutWords(r) {
  const o = r || {};
  const lines = [];
  const kept = Array.isArray(o.kept) ? o.kept : [];
  if (kept.length) {
    // files that share a reason are named together: "a and b (the move-in plan)"
    const groups = [];
    for (const k of kept) {
      const g = groups.find((x) => x.words === k.words);
      if (g) g.files.push(k.file); else groups.push({ words: k.words, files: [k.file] });
    }
    const and = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
    lines.push('These stay in your folder: ' + groups.map((g) => `${and(g.files)} (${g.words})`).join(', ') + '.');
  }
  const commits = Array.isArray(o.commits) ? o.commits : [];
  if (commits.length) {
    lines.push(`Crads-AI made ${commits.length === 1 ? 'one commit' : `${commits.length} commits`} in your repository before you moved out. ${commits.length === 1 ? 'It stays' : 'They stay'} in your git history; nothing was rewritten:`);
    for (const c of commits.slice(0, 50)) lines.push(`  ${c.short || String(c.sha || '').slice(0, 7)} ${c.subject || ''}`);
    if (commits.length > 50) lines.push(`  and ${commits.length - 50} more`);
    lines.push('To take one back out without rewriting anything, run git revert with its id.');
  } else if (Array.isArray(o.commits)) {
    lines.push('Crads-AI made no commits in your repository.');
  }
  return lines.join('\n');
}

// The host teardown (wizard/provision/adopt-host.mjs): undoes every host
// change the shared-server setup recorded in .kernel/move-in/host-setup.json.
export async function defaultTeardown(client, o) {
  return teardownSharedHost(client, o);
}
