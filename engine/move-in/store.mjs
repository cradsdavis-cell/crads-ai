// store.mjs: where /move-in keeps things, and the one writer for them.
//
//   <state>/.kernel/move-in/host-inventory.json  written by host setup (Builder A's
//                                                 side), read here. Holds the EXACT
//                                                 crontab lines; never committed
//                                                 (.kernel/ is in the credential floor).
//   <state>/cockpit/move-in.json                  the plan, machine-readable, read by
//                                                 the app. On an adopted brain cockpit/
//                                                 is tracked, so nothing credential-
//                                                 shaped is ever written here: lines
//                                                 are shown redacted and host steps
//                                                 point at the inventory by hash.
//   <state>/move-in.md                            the plan in words, re-rendered on
//                                                 every change.
//   <state>/.kernel/move-in/undo/<step>.json      the exact bytes a step replaced,
//                                                 kept beside the inventory for the
//                                                 same reason (a carried-over token's
//                                                 prior value is a secret).
//
// ONE WRITER (trap 7): the planner and the apply CLI both come through
// withLock(), so two clicks in two windows cannot interleave a read and a write.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

export const invFile = (s) => path.join(s, '.kernel', 'move-in', 'host-inventory.json');
export const planFile = (s) => path.join(s, 'cockpit', 'move-in.json');
export const mdFile = (s) => path.join(s, 'move-in.md');
export const undoDir = (s) => path.join(s, '.kernel', 'move-in', 'undo');
export const undoFile = (s, id) => path.join(undoDir(s), `${id}.json`);
const lockFile = (s) => path.join(s, '.kernel', 'move-in', 'lock');
export const NEW_FILES = ['cockpit/move-in.json', 'move-in.md'];

export function readJson(f, fallback = null) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
}

export function writeAtomic(f, text, mode) {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, text, mode != null ? { mode } : undefined);
  renameSync(tmp, f);
}

export function readInventory(stateDir) {
  const inv = readJson(invFile(stateDir));
  return inv && typeof inv === 'object' && !Array.isArray(inv) ? inv : null;
}

export function readPlan(stateDir) {
  const p = readJson(planFile(stateDir));
  return p && typeof p === 'object' && Array.isArray(p.steps) ? p : null;
}

export function withLock(stateDir, fn) {
  const f = lockFile(stateDir);
  mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { closeSync(openSync(f, 'wx')); break; } catch {
      // a lock older than two minutes is a crashed run, not a live one
      let old = false;
      try { old = Date.now() - statSync(f).mtimeMs > 120000; } catch { old = true; }
      if (old && i === 0) { try { rmSync(f, { force: true }); } catch { /* raced */ } continue; }
      throw new Error('another move-in change is running; wait a moment and try again');
    }
  }
  try { return fn(); } finally { try { rmSync(f, { force: true }); } catch { /* gone */ } }
}

// ownership.json: merge, never replace (host setup owns the other keys).
export function readOwnership(stateDir) {
  return readJson(path.join(stateDir, 'ownership.json'), {}) || {};
}
export function setOwnershipFlags(stateDir, flags) {
  const rec = readOwnership(stateDir);
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) delete rec[k]; else rec[k] = v;
  }
  writeAtomic(path.join(stateDir, 'ownership.json'), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}
export function setMovingIn(stateDir, value) {
  return setOwnershipFlags(stateDir, { moving_in: value });
}

// ---- the plan in words --------------------------------------------------------------
const STATE_WORDS = { pending: 'waiting for your yes', approved: 'approved, not done yet', done: 'done', skipped: 'skipped', undone: 'undone' };

export function renderMd(plan) {
  const out = [];
  out.push('# Moving in', '');
  out.push('This is the plan for moving what your server already does into Crads-AI. Nothing on it happens until you approve it, '
    + 'one step at a time or a batch at once, and every step can be undone. Your assistant keeps this page up to date; '
    + 'the app shows the same plan on its Move in page.', '');
  if (plan.brain_root) out.push(`Your brain folder on the server: \`${plan.brain_root}\` (inside your mineral it is \`/state\`).`, '');
  const groups = [
    ['On your mineral', (s) => s.side === 'container' && s.kind !== 'note'],
    ['On your server (switching jobs over)', (s) => s.side === 'host'],
    ['Things to know (nothing changes)', (s) => s.kind === 'note'],
  ];
  for (const [title, pick] of groups) {
    const steps = plan.steps.filter(pick);
    if (!steps.length) continue;
    out.push(`## ${title}`, '');
    for (const s of steps) {
      out.push(`### ${s.title} (${STATE_WORDS[s.state] || s.state})`, '');
      out.push(s.what, '');
      if (s.why) out.push(`Why: ${s.why}`, '');
      if (s.hold) out.push(`Waiting: ${s.hold}`, '');
      if (s.after_finish) out.push('Waiting: this step opens once you finish moving in, and it does not count toward finishing.', '');
      if (s.source && s.source.display) out.push('On your server:', '', '```', s.source.display, '```', '');
      if (s.details && s.details.length) { for (const d of s.details) out.push(`- ${d.name}: ${d.words}`); out.push(''); }
      if (s.undo_words) out.push(`To undo: ${s.undo_words}`, '');
    }
  }
  if ((plan.still_on_server || []).length) {
    out.push('## Still on the server', '', 'These keep running on your server, outside Crads-AI. The Health card lists them so they are not forgotten.', '');
    for (const x of plan.still_on_server) out.push(`- **${x.name}**: ${x.what}${x.why ? ` (${x.why})` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

export function savePlan(stateDir, plan) {
  writeAtomic(planFile(stateDir), JSON.stringify(plan, null, 2) + '\n');
  writeAtomic(mdFile(stateDir), renderMd(plan));
}
