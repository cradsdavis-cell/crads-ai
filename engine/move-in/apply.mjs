#!/usr/bin/env node
// apply.mjs: approve, apply and undo /move-in steps, inside the mineral
// (spec 2026-10-17-adopt-existing-server.md § 3, "every step can be undone").
//
//   node apply.mjs <state> show                         MOVEIN_STATE {json}: the plan + moving_in, for the app
//   node apply.mjs <state> approve <id> [<id>...]       pending/undone -> approved
//   node apply.mjs <state> skip <id> | unskip <id>
//   node apply.mjs <state> apply <id>                   a CONTAINER step, in-process, its undo recorded
//   node apply.mjs <state> undo <id>                    reverse a container step: the exact prior bytes
//   node apply.mjs <state> host-begin <id> apply|undo   a HOST step's container half + the op the app runs: HOST_OP {json}
//   node apply.mjs <state> host-end <id> apply|undo ok|fail   stdin: base64 JSON of what the server said
//   node apply.mjs <state> host-check <id>              a half-done host step: the read-only check op, HOST_OP {op}
//   node apply.mjs <state> host-checked <id>            stdin: base64 JSON of what the check saw; CHECK {server, words, choices}
//   node apply.mjs <state> host-resolve <id> finish|rollback   stdin: a fresh check; RESOLVE {op|null, end, result}
//   node apply.mjs <state> move-out-begin               hold everything (moving_out + moving_in), then
//                                                       MOVEOUT_BEGIN {kept, commits}: what stays behind
//   node apply.mjs <state> move-out-report              MOVEOUT_REPORT {kept, commits}, read only
//   node apply.mjs <state> move-out-list                MOVEOUT [{id,side}] newest first
//   node apply.mjs <state> finish                       every step done or skipped: clear moving_in
//
// HOST STEPS ARE NEVER RUN HERE. The container cannot reach the server it runs
// on, and must not: the plan is the container's, the crontab is the server's,
// and only the person's app holds the key between them. host-begin does the
// container half that comes first and hands the app ONE allow-listed op
// (host-ops.mjs) with its arguments, read from the inventory by hash, never
// from the page; host-end records what happened and does the half that comes
// after. A host step that failed on the server rolls its container half back.
//
// EXACT UNDO. Every file a step writes is snapshotted first into
// .kernel/move-in/undo/<step>.json (never committed: a carried token's prior
// value is a secret). Undo puts the prior bytes back, or removes a file that
// did not exist, as long as the file is still what the step wrote. When the
// person has changed it since, the two JSON schedule files fall back to taking
// out only what the step added; anything else is refused and left alone.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { canMove, settled, STEP_ID_RE, HOST_KINDS, telegramNow, remoteReach } from './lib.mjs';
import { remoteUrlOf } from './plan.mjs';
import { validateHostOp } from './host-ops.mjs';
import { readPlan, readInventory, savePlan, withLock, undoFile, writeAtomic, readJson, readOwnership, setOwnershipFlags, NEW_FILES } from './store.mjs';
import { saveChanges as saveScriptChanges, problemFor as scriptProblemFor } from '../cron/scripts.mjs';
import { normalizeEntry as normalizeScriptEntry } from '../cron/scripts-lib.mjs';
import { lastRunByScript, lastOkRunBySkill, lastRunBySkill } from '../lib/run-ledger.mjs';
import { isMain } from '../lib/is-main.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export class MoveInError extends Error {}
const fail = (m) => { throw new MoveInError(m); };

// ---- snapshots ---------------------------------------------------------------------
function readBytes(f) { try { return readFileSync(f); } catch { return null; } }
function modeOf(f) { try { return statSync(f).mode & 0o777; } catch { return null; } }

function snap(stateDir, rel) {
  const f = path.join(stateDir, rel);
  const b = readBytes(f);
  return { rel, existed: b != null, before_b64: b == null ? null : b.toString('base64'), mode: modeOf(f) };
}
function sealSnap(stateDir, s) {
  const b = readBytes(path.join(stateDir, s.rel));
  s.after_sha = b == null ? null : sha(b);
  return s;
}
// put one file back; `fallback(cur)` returns replacement bytes when the file
// changed since the step wrote it, or null to refuse
function restore(stateDir, s, fallback) {
  const f = path.join(stateDir, s.rel);
  const cur = readBytes(f);
  const curSha = cur == null ? null : sha(cur);
  if (curSha === s.after_sha) {
    if (!s.existed) { rmSync(f, { force: true }); return; }
    writeFileSync(f, Buffer.from(s.before_b64, 'base64'));
    if (s.mode != null) chmodSync(f, s.mode);
    return;
  }
  const next = fallback ? fallback(cur) : null;
  if (next == null) fail(`${s.rel} has changed since this step wrote it, so the app will not overwrite it. Undo that change first, or skip undoing this step`);
  writeFileSync(f, next);
}
function canRestore(stateDir, s, hasFallback) {
  const cur = readBytes(path.join(stateDir, s.rel));
  return (cur == null ? null : sha(cur)) === s.after_sha || hasFallback;
}

const readSide = (stateDir, id) => readJson(undoFile(stateDir, id), {}) || {};
const writeSide = (stateDir, id, side) => writeAtomic(undoFile(stateDir, id), JSON.stringify(side, null, 2) + '\n', 0o600);

// ---- JSON schedule files ------------------------------------------------------------------
const CAD = 'cockpit/cadence.json';
const SCR = 'cockpit/scripts.json';
const json = (stateDir, rel) => readJson(path.join(stateDir, rel), null);
const dump = (o) => JSON.stringify(o, null, 2) + '\n';

function cadenceWith(raw, mutate) {
  let c = raw && typeof raw === 'object' && !Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : {};
  if (c.version !== 2) {
    // a v1 file (or none): v2 keeps every v1 entry readable (cadence-lib normalizeEntry)
    const jobs = {}; for (const [k, v] of Object.entries(c)) if (v && typeof v === 'object') jobs[k] = v;
    c = { version: 2, jobs };
  }
  if (!c.jobs || typeof c.jobs !== 'object') c.jobs = {};
  mutate(c.jobs);
  return c;
}

// ---- container steps --------------------------------------------------------------------------
function applyContainer(stateDir, step, inv) {
  const files = [];
  const write = (rel, text, mode) => {
    files.push(snap(stateDir, rel));
    const f = path.join(stateDir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, text, mode != null ? { mode } : undefined);
    if (mode != null) chmodSync(f, mode);
  };
  if (step.kind === 'note') return { files, words: 'Noted. Nothing changed.' };
  if (step.kind === 'gitignore') {
    const cur = readBytes(path.join(stateDir, '.gitignore'));
    const text = cur ? cur.toString('utf8') : '';
    const lines = (step.lines || []).filter((l) => typeof l === 'string' && /^[A-Za-z0-9._/-]+$/.test(l));
    if (!lines.length) fail('there are no lines to add');
    const block = `${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}# Written by Crads-AI while it ran (added by the move-in)\n${lines.join('\n')}\n`;
    write('.gitignore', text + block);
    return { files, words: `Added ${lines.length} line${lines.length === 1 ? '' : 's'} to .gitignore.` };
  }
  if (step.kind === 'cadence-add') {
    const j = step.job || {};
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(j.id || ''))) fail('this step names no skill');
    const sk = j.skill;
    if (sk) {
      if (!/^\.claude\/skills\/[a-z0-9][a-z0-9-]{0,62}\/SKILL\.md$/.test(String(sk.path || '')) || typeof sk.text !== 'string') fail('the new skill in this step is not readable');
      if (existsSync(path.join(stateDir, sk.path))) fail(`${sk.path} already exists; the plan will not write over a skill. Make the plan again`);
      write(sk.path, sk.text);
    }
    const raw = json(stateDir, CAD);
    const next = cadenceWith(raw, (jobs) => {
      if (jobs[j.id] && !sk) fail(`${j.id} is already scheduled in cockpit/cadence.json`);
      jobs[j.id] = { ...j.entry, enabled: false };
    });
    write(CAD, dump(next));
    return { files, words: `${j.id} is on your Skills page, switched off.` };
  }
  if (step.kind === 'script-add') {
    const j = step.job || {};
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(j.id || ''))) fail('this step names no script');
    const raw = json(stateDir, SCR) || {};
    const next = JSON.parse(JSON.stringify(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}));
    next.version = 1;
    if (!next.scripts || typeof next.scripts !== 'object' || Array.isArray(next.scripts)) next.scripts = {};
    if (next.scripts[j.id]) fail(`${j.id} is already in your Scripts list`);
    next.scripts[j.id] = { ...j.entry, enabled: false };
    write(SCR, dump(next));
    return { files, words: `${j.id} is in your Scripts list, switched off.` };
  }
  if (step.kind === 'telegram-carry') {
    const rel = step.telegram && step.telegram.env_file;
    if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..') || !(inv && (inv.env_files || []).includes(rel))) fail('the settings file for your bot is not one the server inventory recorded');
    const env = parseEnv(readBytes(path.join(stateDir, rel)));
    if (!env.TELEGRAM_BOT_TOKEN) fail(`${rel} no longer has TELEGRAM_BOT_TOKEN`);
    mkdirSync(path.join(stateDir, 'secrets'), { recursive: true, mode: 0o700 });
    write('secrets/telegram_bot_token', env.TELEGRAM_BOT_TOKEN, 0o600);
    if (env.TELEGRAM_CHAT_ID) write('secrets/telegram_chat_id', env.TELEGRAM_CHAT_ID, 0o600);
    // who answers: your own program, until the separate cutover step
    write('.kernel/telegram-reader', 'host\n', 0o600);
    return { files, words: 'Telegram is connected with your own bot. Your program on the server still answers it, and Crads-AI sends nothing until you finish moving in.' };
  }
  fail(`${step.kind} is not a step that runs inside your mineral`);
}

function parseEnv(buf) {
  const env = {};
  for (const raw of String(buf || '').split('\n')) {
    const m = raw.trim().match(/^(?:export\s+)?(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
  return env;
}

// The fallback when a schedule file changed after the step: take out (or switch
// off) only what this step put in, and keep everything else the person did.
function jsonFallback(step, rel) {
  const j = step.job || {};
  if (rel === CAD && step.kind === 'cadence-add') return (cur) => {
    let o; try { o = JSON.parse(String(cur)); } catch { return null; }
    const next = cadenceWith(o, (jobs) => { delete jobs[j.id]; });
    return dump(next);
  };
  if (rel === SCR && step.kind === 'script-add') return (cur) => {
    let o; try { o = JSON.parse(String(cur)); } catch { return null; }
    if (o && o.scripts) delete o.scripts[j.id];
    return dump(o || {});
  };
  return null;
}

function undoFiles(stateDir, step, files) {
  const list = [...(files || [])].reverse();
  // all or nothing: check every file before touching any
  for (const s of list) if (!canRestore(stateDir, s, !!jsonFallback(step, s.rel))) {
    fail(`${s.rel} has changed since this step wrote it, so the app will not overwrite it. Undo that change first, or leave this step done`);
  }
  for (const s of list) restore(stateDir, s, jsonFallback(step, s.rel));
}

// ---- the container half of a host step ------------------------------------------------------------
function doHalf(stateDir, step) {
  const h = step.half || {};
  if (h.action === 'enable') {
    if (h.target === 'scripts') {
      const s = snap(stateDir, SCR);
      const r = saveScriptChanges(stateDir, { [h.id]: { enabled: true } });
      if (!r.ok) fail(r.error);
      return [sealSnap(stateDir, s)];
    }
    const s = snap(stateDir, CAD);
    const raw = json(stateDir, CAD);
    const next = cadenceWith(raw, (jobs) => {
      if (!jobs[h.id]) fail(`${h.id} is not on your Skills page; apply the step that adds it first`);
      jobs[h.id] = { ...jobs[h.id], enabled: true };
    });
    writeAtomic(path.join(stateDir, CAD), dump(next));
    return [sealSnap(stateDir, s)];
  }
  if (h.action === 'telegram-reader') {
    // Crads-AI answers from now on: its Telegram reader starts when this marker is gone
    const s = snap(stateDir, '.kernel/telegram-reader');
    rmSync(path.join(stateDir, '.kernel/telegram-reader'), { force: true });
    return [sealSnap(stateDir, s)];
  }
  fail('this server step has no Crads-AI side the app knows');
}
function undoHalf(stateDir, step, files) {
  const h = step.half || {};
  const fallback = h.action === 'enable' ? (cur) => {
    let o; try { o = JSON.parse(String(cur)); } catch { return null; }
    if (h.target === 'scripts') { if (o && o.scripts && o.scripts[h.id]) o.scripts[h.id].enabled = false; return dump(o); }
    return dump(cadenceWith(o, (jobs) => { if (jobs[h.id]) jobs[h.id].enabled = false; }));
  } : (cur) => (cur == null ? 'host\n' : null);
  for (const s of [...(files || [])].reverse()) restore(stateDir, s, fallback);
}

// ---- the op for the app ------------------------------------------------------------------------------
function inventoryLine(inv, user, textSha) {
  const rows = (inv && Array.isArray(inv.crontab) ? inv.crontab : []).filter((r) => String(r.user) === user
    && createHash('sha256').update(String(r.text ?? ''), 'utf8').digest('hex') === textSha);
  if (rows.length !== 1) fail(rows.length ? 'that line appears more than once in the server inventory, so the app will not guess which one to switch off'
    : 'that crontab line is not in the server inventory any more; make the plan again');
  return String(rows[0].text);
}

function opFor(step, inv, plan, action, ymd) {
  const o = step.host_op || {};
  if (o.op === 'cron-comment') {
    const line = inventoryLine(inv, String(o.user), String(o.text_sha256));
    return { op: 'cron-comment', action, user: String(o.user), line_text: line, ymd: action === 'apply' ? ymd : String((step.result || {}).ymd || '') };
  }
  if (o.op === 'unit-disable') {
    const op = { op: 'unit-disable', action, name: String(o.name), scope: o.scope === 'user' ? 'user' : 'system', user: String(plan.login || 'root') };
    if (action === 'undo') op.prior = (step.result || {}).prior || null;
    return op;
  }
  fail('this step does not change anything on the server');
}

function ranOnce(stateDir, step, plan) {
  if (step.kind !== 'cutover') return null;
  const h = step.half || {};
  const addStep = step.after ? plan.steps.find((s) => s.id === step.after) : null;
  const since = (addStep && addStep.done_at) || '';
  const last = h.target === 'scripts' ? lastRunByScript(stateDir)[h.id] : lastOkRunBySkill(stateDir)[h.id];
  if (!last || last.status !== 'ok' || String(last.ts || '') < since) {
    return `Run ${h.id} once from the Move in page first, and check it did what the server's copy does. `
      + (last && last.status === 'fail' ? 'Its last run failed.' : 'It has not finished a run inside your mineral yet.');
  }
  return null;
}

// ---- the commands -------------------------------------------------------------------------------------
function load(stateDir) {
  const plan = readPlan(stateDir);
  if (!plan) fail('there is no move-in plan yet; make it first');
  return plan;
}
function stepOf(plan, id) {
  if (!STEP_ID_RE.test(String(id || ''))) fail('that is not a step id');
  const s = plan.steps.find((x) => x.id === id);
  if (!s) fail(`there is no step called ${id} in the plan`);
  return s;
}
const nowIso = () => new Date().toISOString();
function refreshTelegram(plan) {
  const carry = plan.steps.find((s) => s.id === 'telegram-carry');
  const cut = plan.steps.find((s) => s.id === 'telegram-cutover');
  if (plan.telegram) {
    plan.telegram.carried = !!(carry && carry.state === 'done');
    plan.telegram.answered_by = cut && cut.state === 'done' ? 'crads' : 'host';
  }
}
function commit(stateDir, plan) { refreshTelegram(plan); savePlan(stateDir, plan); }
// a server step that is no longer waiting on the server
function settle(step) { delete step.in_flight; delete step.in_flight_ymd; delete step.check; }
function markDone(plan, step) {
  plan.seq = (plan.seq || 0) + 1;
  step.state = 'done'; step.done_seq = plan.seq; step.done_at = nowIso(); settle(step);
}

export function approve(stateDir, ids) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const said = [];
    for (const id of ids) {
      const s = stepOf(plan, id);
      if (!canMove(s, 'approve')) { said.push(`${id} is ${s.state}, so there is nothing to approve`); continue; }
      s.state = 'approved'; s.approved_at = nowIso(); said.push(`${id} approved`);
    }
    commit(stateDir, plan);
    return said;
  });
}

export function skip(stateDir, id, back = false) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = stepOf(plan, id);
    if (!canMove(s, back ? 'unskip' : 'skip')) fail(`${id} is ${s.state}; ${back ? 'only a skipped step can come back' : 'a done step is undone, not skipped'}`);
    if (!back && plan.steps.some((x) => x.after === id && (x.state === 'done' || x.state === 'approved'))) fail(`a later step depends on ${id}; skip that one first`);
    s.state = back ? 'pending' : 'skipped';
    commit(stateDir, plan);
    return back ? `${id} is back in the plan` : `${id} skipped`;
  });
}

export function applyStep(stateDir, id) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = stepOf(plan, id);
    if (s.side !== 'container') fail(`${id} changes your server, so the app does it over SSH, not your mineral`);
    if (!canMove(s, 'apply')) fail(s.state === 'pending' ? `${id} has not been approved yet` : `${id} is ${s.state}`);
    if (s.after) { const d = plan.steps.find((x) => x.id === s.after); if (!d || d.state !== 'done') fail(`${s.after} has to be done first`); }
    const r = applyContainer(stateDir, s, readInventory(stateDir));
    writeSide(stateDir, id, { files: r.files.map((f) => sealSnap(stateDir, f)) });
    s.undo = r.files.map((f) => ({ file: f.rel, restore: f.existed ? 'prior bytes' : 'remove' }));
    s.result = { words: r.words };
    markDone(plan, s);
    commit(stateDir, plan);
    return r.words;
  });
}

export function undoStep(stateDir, id) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = stepOf(plan, id);
    if (s.side !== 'container') fail(`${id} changed your server, so the app undoes it over SSH`);
    if (!canMove(s, 'undo')) fail(`${id} is ${s.state}, so there is nothing to undo`);
    const later = plan.steps.find((x) => x.after === id && x.state === 'done');
    if (later) fail(`${later.id} depends on this step; undo that first`);
    const side = readSide(stateDir, id);
    undoFiles(stateDir, s, side.files);
    rmSync(undoFile(stateDir, id), { force: true });
    s.state = 'undone'; s.undo = []; delete s.done_seq; delete s.done_at;
    commit(stateDir, plan);
    return `${id} undone: the files are as they were before it.`;
  });
}

export function hostBegin(stateDir, id, action, { ymd = nowIso().slice(0, 10) } = {}) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = stepOf(plan, id);
    if (!HOST_KINDS.includes(s.kind)) fail(`${id} does not change your server`);
    if (s.in_flight) fail(`${id} is already part-way through; finish or retry it`);
    const inv = readInventory(stateDir);
    if (action === 'apply') {
      if (!canMove(s, 'apply')) fail(s.state === 'pending' ? `${id} has not been approved yet` : `${id} is ${s.state}`);
      if (s.after) { const d = plan.steps.find((x) => x.id === s.after); if (!d || d.state !== 'done') fail(`${s.after} has to be done first`); }
      if (s.after_finish && readOwnership(stateDir).moving_in === true) {
        fail('this step comes after you finish moving in. While you are moving in, Crads-AI\'s own Telegram reader is held back, so switching your program off now would leave nobody answering your bot');
      }
      if (s.hold && remoteReach(remoteUrlOf(stateDir, String(((inv || {}).git || {}).remote || 'origin'))).usable === false) fail(s.hold.replace(/\.?$/, ''));
      const why = ranOnce(stateDir, s, plan);
      if (why) fail(why);
      const op = opFor(s, inv, plan, 'apply', ymd);
      const bad = validateHostOp(op); if (bad) fail(bad);
      const side = { half: [] };
      if ((s.half || {}).when === 'before') side.half = doHalf(stateDir, s);
      writeSide(stateDir, id, side);
      s.in_flight = 'apply';
      s.in_flight_ymd = op.op === 'cron-comment' ? op.ymd : null;   // the date the line is being tagged with, for a check later
      commit(stateDir, plan);
      return op;
    }
    if (action === 'undo') {
      if (!canMove(s, 'undo')) fail(`${id} is ${s.state}, so there is nothing to undo`);
      const op = opFor(s, inv, plan, 'undo');
      const bad = validateHostOp(op); if (bad) fail(bad);
      const side = readSide(stateDir, id);
      // reverse order: what came after the server change is undone before it
      if ((s.half || {}).when === 'after') { undoHalf(stateDir, s, side.half); side.half_undone = true; writeSide(stateDir, id, side); }
      s.in_flight = 'undo';
      commit(stateDir, plan);
      return op;
    }
    fail('a server step is either done or undone');
  });
}

export function hostEnd(stateDir, id, action, ok, result = {}) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = stepOf(plan, id);
    if (s.in_flight !== action) fail(`${id} was not waiting for the server`);
    const side = readSide(stateDir, id);
    const when = (s.half || {}).when;
    if (action === 'apply') {
      if (!ok) {
        if (when === 'before') undoHalf(stateDir, s, side.half);
        rmSync(undoFile(stateDir, id), { force: true });
        settle(s);
        commit(stateDir, plan);
        return `${id} did not change your server, so the Crads-AI side was put back too.`;
      }
      if (when === 'after') side.half = doHalf(stateDir, s);
      writeSide(stateDir, id, side);
      s.result = { ymd: /^\d{4}-\d{2}-\d{2}$/.test(String(result.ymd || '')) ? result.ymd : null, line_no: Number(result.line_no) || null,
        prior: result.prior && typeof result.prior === 'object' ? { enabled: String(result.prior.enabled || 'unknown'), active: String(result.prior.active || 'unknown') } : null,
        warning: result.warning ? String(result.warning).slice(0, 300) : undefined };
      s.undo = [
        ...(when === 'before' ? [] : (side.half || []).map((f) => ({ file: f.rel, restore: f.existed ? 'prior bytes' : 'remove' }))),
        { host: (s.host_op || {}).op === 'unit-disable' ? `switch ${s.host_op.name} back to how it was` : 'take "# crads-move-in" off the crontab line' },
        ...(when === 'before' ? (side.half || []).map((f) => ({ file: f.rel, restore: f.existed ? 'prior bytes' : 'remove' })) : []),
      ];
      markDone(plan, s);
      commit(stateDir, plan);
      return `${id} done.`;
    }
    if (!ok) {
      if (when === 'after' && side.half_undone) { side.half = doHalf(stateDir, s); delete side.half_undone; writeSide(stateDir, id, side); }
      settle(s);
      commit(stateDir, plan);
      return `${id} is still done: your server did not change back, so neither did Crads-AI.`;
    }
    if (when === 'before') undoHalf(stateDir, s, side.half);
    rmSync(undoFile(stateDir, id), { force: true });
    s.state = 'undone'; s.undo = []; settle(s); delete s.done_seq; delete s.done_at; delete s.result;
    commit(stateDir, plan);
    return `${id} undone.`;
  });
}

// ---- a server step the app stopped half way through ------------------------------------------------
// The app does host-begin, the server op, then host-end. If it dies between the
// first and the last, the step stays `in_flight` and the plan no longer knows
// whether the server changed. These three never guess and never take a command:
//   host-check   the read-only form of the step's own op, for the app to run
//   host-checked records what the server showed, and which ways out are safe
//   host-resolve the one op (if any) that makes the server match the choice,
//                and how host-end must close the step
// "finish" carries the interrupted move through; "rollback" puts it back.

const ENABLED = ['enabled', 'enabled-runtime'];
const RUNNING = ['active', 'activating', 'reloading'];

// The date in play for a cron step: the one being written (apply) or the one
// already on the line (undo).
function ymdInPlay(s) { return s.in_flight === 'apply' ? s.in_flight_ymd : (s.result || {}).ymd; }

// What the app knows of the service before it was switched off, when the
// switch-off's own answer was lost: what the server inventory recorded.
function assumedPrior(s, inv) {
  const u = (inv && Array.isArray(inv.units) ? inv.units : []).find((x) => String(x.name) === String((s.host_op || {}).name));
  return { enabled: 'enabled', active: u && u.active === false ? 'inactive' : 'active' };
}

// 'changed' = the server looks the way the step's apply op leaves it (the line
// commented, the service off); 'unchanged' = the way it was before; 'unclear'
// = neither, and nothing is offered but checking again.
export function serverShows(step, check) {
  const o = step.host_op || {};
  const c = check && typeof check === 'object' ? check : {};
  if (o.op === 'cron-comment') {
    const plain = Number(c.plain), commented = Number(c.commented);
    if (commented === 1 && plain === 0) return { server: 'changed', words: 'Your server shows the line switched off, with "# crads-move-in" in front of it.' };
    if (plain === 1 && commented === 0) return { server: 'unchanged', words: 'Your server shows the line as it was, still running.' };
    if (!plain && !commented) return { server: 'unclear', words: 'The line is not in the crontab in either form any more, so someone changed it by hand. Check the crontab on your server, then check again.' };
    return { server: 'unclear', words: 'The line is in the crontab more than once, so the app will not guess which one this step meant. Tidy the crontab on your server, then check again.' };
  }
  if (o.op === 'unit-disable') {
    const en = String(c.enabled || ''), ac = String(c.active || '');
    if (!ENABLED.includes(en) && !RUNNING.includes(ac) && en !== 'unknown' && en) return { server: 'changed', words: `Your server shows ${o.name} switched off and stopped.` };
    if (ENABLED.includes(en)) return { server: 'unchanged', words: `Your server shows ${o.name} switched on${RUNNING.includes(ac) ? ' and running' : ''}, as it was.` };
    return { server: 'unclear', words: `systemd did not say clearly what ${o.name} is doing (${en || 'no answer'}, ${ac || 'no answer'}). Check it on your server, then check again.` };
  }
  return { server: 'unclear', words: 'This step does not change anything on the server.' };
}

function halfDone(plan, id) {
  const s = stepOf(plan, id);
  if (!HOST_KINDS.includes(s.kind)) fail(`${id} does not change your server`);
  if (s.in_flight !== 'apply' && s.in_flight !== 'undo') fail(`${id} is not part-way through; there is nothing to check`);
  return s;
}

export function hostCheckOp(stateDir, id) {
  const plan = load(stateDir);
  const s = halfDone(plan, id);
  const inv = readInventory(stateDir);
  const o = s.host_op || {};
  let op;
  if (o.op === 'cron-comment') {
    const ymd = ymdInPlay(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) fail(`${id} lost the date it was tagging the line with, so the app cannot read the line back; check the crontab on your server by hand`);
    op = { op: 'cron-comment', action: 'check', user: String(o.user), line_text: inventoryLine(inv, String(o.user), String(o.text_sha256)), ymd };
  } else if (o.op === 'unit-disable') {
    op = { op: 'unit-disable', action: 'check', name: String(o.name), scope: o.scope === 'user' ? 'user' : 'system', user: String(plan.login || 'root') };
  } else fail('this step does not change anything on the server');
  const bad = validateHostOp(op); if (bad) fail(bad);
  return op;
}

const CHOICE_WORDS = {
  apply: { finish: 'Finish the step', rollback: 'Put it back as it was' },
  undo: { finish: 'Finish undoing it', rollback: 'Keep it done' },
};

export function hostChecked(stateDir, id, check) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    const s = halfDone(plan, id);
    const seen = serverShows(s, check);
    s.check = { at: nowIso(), server: seen.server, words: seen.words,
      choices: seen.server === 'unclear' ? [] : ['finish', 'rollback'].map((c) => ({ choice: c, label: CHOICE_WORDS[s.in_flight][c] })) };
    commit(stateDir, plan);
    return s.check;
  });
}

// What to do, from a FRESH check (the page's may be minutes old). Pure apart
// from reading the plan: { op: <one allow-listed op> | null, end: 'ok'|'fail', result }.
export function hostResolve(stateDir, id, choice, check) {
  if (choice !== 'finish' && choice !== 'rollback') fail('the way out is either finish or rollback');
  const plan = load(stateDir);
  const s = halfDone(plan, id);
  const inv = readInventory(stateDir);
  const seen = serverShows(s, check);
  if (seen.server === 'unclear') fail(seen.words);
  const o = s.host_op || {};
  const cron = o.op === 'cron-comment';
  const ymd = ymdInPlay(s);
  // the server as the choice wants it: finishing an apply or rolling back an undo
  // both mean "the step's change is on the server"
  const wantChanged = (s.in_flight === 'apply') === (choice === 'finish');
  const end = choice === 'finish' ? 'ok' : 'fail';
  const already = (seen.server === 'changed') === wantChanged;
  const priorKnown = (s.result || {}).prior || assumedPrior(s, inv);
  if (already) {
    // nothing to do on the server; only finishing an apply records a result
    let result = {};
    if (s.in_flight === 'apply' && end === 'ok') {
      result = cron ? { ymd, line_no: null } : { prior: assumedPrior(s, inv),
        warning: 'the app lost what the service was doing before it was switched off, so undoing this switches it back on as the server inventory recorded it' };
    }
    return { op: null, end, result, words: seen.words };
  }
  const action = wantChanged ? 'apply' : 'undo';
  const op = cron
    ? { op: 'cron-comment', action, user: String(o.user), line_text: inventoryLine(inv, String(o.user), String(o.text_sha256)), ymd }
    : { op: 'unit-disable', action, name: String(o.name), scope: o.scope === 'user' ? 'user' : 'system', user: String(plan.login || 'root'), ...(action === 'undo' ? { prior: priorKnown } : {}) };
  const bad = validateHostOp(op); if (bad) fail(bad);
  return { op, end, words: seen.words };
}

export function moveOutList(stateDir) {
  const plan = load(stateDir);
  return plan.steps.filter((s) => s.state === 'done').sort((a, b) => (b.done_seq || 0) - (a.done_seq || 0)).map((s) => ({ id: s.id, side: s.side }));
}

export function finish(stateDir) {
  return withLock(stateDir, () => {
    const plan = load(stateDir);
    if (plan.steps.some((s) => s.in_flight)) fail('a step is still part-way through');
    if (!settled(plan)) {
      const open = plan.steps.filter((s) => s.state !== 'done' && s.state !== 'skipped').map((s) => s.id);
      fail(`${open.length} step${open.length === 1 ? ' is' : 's are'} not done or skipped yet: ${open.slice(0, 6).join(', ')}${open.length > 6 ? ', ...' : ''}`);
    }
    // moving_out goes too: finishing after a Move out that stopped part way is
    // the person choosing to stay
    setOwnershipFlags(stateDir, { moving_in: false, moving_out: undefined });
    plan.finished_at = nowIso();
    commit(stateDir, plan);
    const tg = plan.steps.find((x) => x.id === 'telegram-cutover');
    return 'You have moved in. The jobs you switched on run on their schedules from the next minute, and Crads-AI\'s own Telegram and nightly backup come up within a couple of minutes.'
      + (tg && tg.state !== 'done' && tg.state !== 'skipped' ? ' Letting Crads-AI answer your Telegram bot is now a step you can take on this page.' : '');
  });
}

// The last run inside the mineral of every job a cutover switches over, so the
// page can show it and wait for a run that outlives its SSH call (rehearsal T4
// finding 7: a Claude run takes minutes, and a cut-short call is not a failure).
function lastRuns(stateDir, plan) {
  const out = {};
  if (!plan) return out;
  let scripts = {}; let skills = {};
  try { scripts = lastRunByScript(stateDir); } catch { scripts = {}; }
  try { skills = lastRunBySkill(stateDir); } catch { skills = {}; }
  for (const s of plan.steps || []) {
    const j = s.job || {};
    if (s.kind !== 'cutover' || !j.id) continue;
    const r = (j.target === 'scripts' ? scripts : skills)[j.id];
    if (r && r.ts) out[`${j.target}:${j.id}`] = { ts: String(r.ts), status: String(r.status || ''), ...(r.error ? { error: String(r.error).slice(0, 300) } : {}) };
  }
  return out;
}

export function show(stateDir) {
  const own = readOwnership(stateDir);
  const plan = readPlan(stateDir);
  const movingIn = own.moving_in === true;
  return { adopted: own.adopted === true, moving_in: movingIn, moving_out: own.moving_out === true, has_inventory: !!readInventory(stateDir),
    telegram_now: telegramNow(plan, { movingIn }), last_runs: lastRuns(stateDir, plan), plan };
}

// ---- Move out ----------------------------------------------------------------------------------
// Before Move out reverses or stops anything, every committer is held: box-up's
// commit on exit, brain-push, the kernel, the scheduler and comms all read
// moving_in (trap 74), and moving_out says why it is back on. Without this the
// container stopping at teardown committed into the person's repo (rehearsal
// T4 finding 1). History is never rewritten: what Crads-AI already committed is
// listed, by sha and subject, so the person knows it stays.
const CRADS_AUTHORS = new Set(['box', 'AI OS kernel']);
const CRADS_EMAILS = new Set(['box@local', 'kernel@ai-os.local']);

export function cradsCommits(stateDir, sinceIso) {
  const args = ['-c', `safe.directory=${stateDir}`, '-C', stateDir, 'log', '--no-color', '-n', '500', '--format=%H%x1f%an%x1f%ae%x1f%s'];
  if (sinceIso && /^\d{4}-\d{2}-\d{2}/.test(String(sinceIso))) args.push(`--since=${sinceIso}`);
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const [sha, an, ae, subject] = line.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(sha || '')) continue;
    if (!CRADS_AUTHORS.has(an) && !CRADS_EMAILS.has(ae)) continue;
    out.push({ sha, short: sha.slice(0, 7), subject: String(subject || '').slice(0, 200), author: an });
  }
  return out;
}

export function moveOutReport(stateDir) {
  const plan = readPlan(stateDir);
  const inv = readInventory(stateDir);
  const since = (plan && plan.started_at) || (inv && inv.collected_at) || null;
  const files = (plan && Array.isArray(plan.new_files) ? plan.new_files : NEW_FILES).map(String);
  const kept = [
    ...files.map((f) => ({ file: f, words: 'the move-in plan' })),
    { file: 'ownership.json', words: 'marks your folder as adopted' },
    { file: '.kernel/move-in/', words: 'the server inventory and undo records (never committed)' },
  ];
  return { since, kept, commits: cradsCommits(stateDir, since) };
}

export function moveOutBegin(stateDir) {
  return withLock(stateDir, () => {
    if (!readPlan(stateDir)) fail('there is no move-in plan here, so there is nothing to move out of');
    setOwnershipFlags(stateDir, { moving_out: true, moving_in: true });
    return moveOutReport(stateDir);
  });
}

// ---- CLI ------------------------------------------------------------------------------------------------
// runCli returns what the CLI prints, so the tests and the app's fakes drive
// the exact same entry point the box does.
export function runCli(argv, stdinText = '') {
  const stateDir = path.resolve(argv[0] || '/state');
  const cmd = argv[1];
  const args = argv.slice(2);
  const out = [];
  const say = (l) => out.push(l);
  let code = 0;
  try {
    if (cmd === 'show') say('MOVEIN_STATE ' + JSON.stringify(show(stateDir)));
    else if (cmd === 'approve') { if (!args.length) fail('name at least one step'); for (const l of approve(stateDir, args)) say(`OK: ${l}`); }
    else if (cmd === 'skip') say(`OK: ${skip(stateDir, args[0])}`);
    else if (cmd === 'unskip') say(`OK: ${skip(stateDir, args[0], true)}`);
    else if (cmd === 'apply') say(`OK: ${applyStep(stateDir, args[0])}`);
    else if (cmd === 'undo') say(`OK: ${undoStep(stateDir, args[0])}`);
    else if (cmd === 'host-begin') say('HOST_OP ' + JSON.stringify(hostBegin(stateDir, args[0], args[1])));
    else if (cmd === 'host-end') {
      let result = {};
      try { const t = String(stdinText || '').trim(); if (t) result = JSON.parse(Buffer.from(t, 'base64').toString('utf8')); } catch { result = {}; }
      if (!result || typeof result !== 'object' || Array.isArray(result)) result = {};
      say(`OK: ${hostEnd(stateDir, args[0], args[1], args[2] === 'ok', result)}`);
    } else if (cmd === 'host-check') say('HOST_OP ' + JSON.stringify(hostCheckOp(stateDir, args[0])));
    else if (cmd === 'host-checked' || cmd === 'host-resolve') {
      let check = {};
      try { const t = String(stdinText || '').trim(); if (t) check = JSON.parse(Buffer.from(t, 'base64').toString('utf8')); } catch { check = {}; }
      if (!check || typeof check !== 'object' || Array.isArray(check)) check = {};
      if (cmd === 'host-checked') say('CHECK ' + JSON.stringify(hostChecked(stateDir, args[0], check)));
      else say('RESOLVE ' + JSON.stringify(hostResolve(stateDir, args[0], args[1], check)));
    } else if (cmd === 'move-out-list') say('MOVEOUT ' + JSON.stringify(moveOutList(stateDir)));
    else if (cmd === 'move-out-begin') say('MOVEOUT_BEGIN ' + JSON.stringify(moveOutBegin(stateDir)));
    else if (cmd === 'move-out-report') say('MOVEOUT_REPORT ' + JSON.stringify(moveOutReport(stateDir)));
    else if (cmd === 'finish') say(`OK: ${finish(stateDir)}`);
    else { say('usage: apply.mjs <state> show|approve|skip|unskip|apply|undo|host-begin|host-end|host-check|host-checked|host-resolve|move-out-begin|move-out-report|move-out-list|finish'); code = 2; }
  } catch (e) {
    say(`ERROR: ${e.message || e}`);
    code = 1;
  }
  return { code, stdout: out.join('\n') + '\n' };
}

// exported for tests that only want the script-row check
export { normalizeScriptEntry, scriptProblemFor };

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  let stdinText = '';
  if (['host-end', 'host-checked', 'host-resolve'].includes(argv[1])) { try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = ''; } }
  const r = runCli(argv, stdinText);
  process.stdout.write(r.stdout);
  // exitCode, never process.exit(): on a pipe stdout is asynchronous, and exiting
  // at once cut every answer off at 64 KB. A real server's plan is ~190 KB, so `show`
  // reached the app truncated and the Move in page said it could not read the plan
  // (adopt rehearsal T4, 2026-10-18).
  process.exitCode = r.code;
}
