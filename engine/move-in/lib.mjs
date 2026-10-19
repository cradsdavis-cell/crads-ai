// lib.mjs: pure logic for /move-in (spec docs/superpowers/specs/2026-10-17-adopt-existing-server.md
// § 3). No filesystem, no clock, no spawn: plan.mjs and apply.mjs own IO, this
// owns meaning, so every rule can be pinned without a server.
//
// What lives here:
//   * reading a crontab line: its schedule, its command, and whether it asks
//     Claude to do something or runs a plain program;
//   * turning a cron schedule into the cadence.json / scripts.json shapes;
//   * mapping a host path onto the brain mounted at /state;
//   * hiding things that look like credentials before a line is shown or saved
//     anywhere a person reads (cockpit/move-in.json is in a tracked folder);
//   * the step vocabulary and its state machine.
//
// THE CONSERVATIVE RULE. A line is a Claude job only when it clearly invokes
// `claude -p` / `claude --print`, or calls a job runner whose job definition
// carries a prompt or a skill. Anything else, including anything we cannot
// read, is a plain script. Every guess is written into the step's `why`.
import path from 'node:path';

const P = path.posix;

// ---- step vocabulary --------------------------------------------------------

export const STEP_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const STATES = ['pending', 'approved', 'done', 'skipped', 'undone'];
export const CONTAINER_KINDS = ['gitignore', 'cadence-add', 'script-add', 'telegram-carry', 'note'];
export const HOST_KINDS = ['cutover', 'telegram-cutover'];
export const KINDS = [...CONTAINER_KINDS, ...HOST_KINDS];
export const COMMENT_TAG = '# crads-move-in';

// What a person may do to a step, from each state. `apply` and `undo` are the
// two that change files; the rest only move the step along.
const MOVES = {
  approve: ['pending', 'undone'],
  skip: ['pending', 'approved', 'undone'],
  unskip: ['skipped'],
  apply: ['approved'],
  undo: ['done'],
};
export function canMove(step, move) {
  const from = MOVES[move];
  return !!(from && step && from.includes(step.state));
}

// Every step done or skipped: the move-in is over and the mineral may run.
// A step marked `after_finish` (letting Crads-AI answer the Telegram bot) only
// becomes possible once the move-in is finished, so it never counts here.
export function settled(plan) {
  const steps = ((plan && plan.steps) || []).filter((s) => !s.after_finish);
  return steps.every((s) => s.state === 'done' || s.state === 'skipped');
}

// Words for a person, from pieces written as clauses: each piece becomes a
// sentence (capital first letter, a full stop at the end), empty pieces are
// dropped and a piece already said is not said twice. Every step's `why` is
// built through this, so a reason never starts in lower case or repeats.
export function sentences(...parts) {
  const out = [];
  const seen = new Set();
  for (const raw of parts.flat()) {
    if (!raw) continue;   // false, 0, null and '' are "nothing to say"
    let t = String(raw).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    t = t[0].toUpperCase() + t.slice(1);
    if (!/[.!?:]$/.test(t)) t += '.';
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(' ');
}

export const slug = (s, max = 40) => String(s || '').toLowerCase()
  .replace(/\.[a-z0-9]{1,5}$/, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'job';

// A name that is not already taken. `taken(id)` answers for the brain.
export function uniqueId(base, taken) {
  let id = slug(base, 56);
  if (!/^[a-z0-9]/.test(id)) id = 'job-' + id;
  if (!taken(id)) return id;
  for (let n = 2; n < 100; n++) { const c = `${id}-${n}`; if (!taken(c)) return c; }
  return `${id}-${Date.now() % 100000}`;
}

// ---- hiding credentials ---------------------------------------------------------
// A crontab line can carry a token inline (`TOKEN=abc node x.mjs`). The exact
// line stays in .kernel/move-in/host-inventory.json, which is never committed;
// everything a person reads, and everything under cockpit/, gets this version.
const SECRETISH = /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASS|PASSWORD|PASSWD|PWD|AUTH|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;
export function redact(text) {
  return String(text == null ? '' : text)
    .replace(SECRETISH, (_, k) => `${k}=<hidden>`)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<hidden>')                 // a Telegram bot token
    .replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{16,}\b/g, '<hidden>')
    .replace(/(--(?:token|key|password|secret)[= ])\S+/gi, '$1<hidden>')
    // a long run with letters AND digits and no slash: a key or a hash, not a path
    .replace(/(?<![A-Za-z0-9/._-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}={0,2}(?![A-Za-z0-9/._-])/g, '<hidden>');
}

// ---- host paths onto /state ---------------------------------------------------------

export function homeOf(login) {
  return login === 'root' ? '/root' : `/home/${login}`;
}

// `~`, `$HOME` and `${HOME}` as cron would see them for this login.
export function expandHome(s, login) {
  const h = homeOf(login);
  return String(s).replace(/^~(?=\/|$)/, h).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, h);
}

export function underDir(dir, p) {
  const d = P.resolve(dir); const q = P.resolve(p);
  return q === d || q.startsWith(d === '/' ? '/' : d + '/');
}

// The container path for a host path inside the brain, else null.
export function toContainer(hostPath, brainRoot, stateDir) {
  if (!hostPath || !P.isAbsolute(hostPath) || !brainRoot) return null;
  if (!underDir(brainRoot, hostPath)) return null;
  const rel = P.relative(P.resolve(brainRoot), P.resolve(hostPath));
  return rel ? P.join(stateDir, rel) : stateDir;
}

// ---- the shell, as far as cron lines need it ------------------------------------------
// Words, operators and redirections. Quotes and backslashes are understood; a
// word that would be expanded by the shell (a `$` outside single quotes, a
// backtick) is flagged so the caller knows argv would not be faithful.
const OPS = ['&&', '||', ';;', ';', '|', '&', '(', ')'];
export function tokenize(cmd) {
  const toks = [];
  const s = String(cmd);
  let i = 0, word = null, expands = false, quoted = false;
  const flush = () => {
    if (word != null) toks.push({ t: 'word', v: word, expands, quoted });
    word = null; expands = false; quoted = false;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { toks, error: 'an unclosed quote' };
      word = (word || '') + s.slice(i + 1, j); quoted = true; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === '$' || s[j] === '`') expands = true;
        buf += s[j]; j++;
      }
      if (j >= s.length) return { toks, error: 'an unclosed quote' };
      word = (word || '') + buf; quoted = true; i = j + 1; continue;
    }
    if (c === '\\') { word = (word || '') + (s[i + 1] || ''); i += 2; continue; }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '$' || c === '`') expands = true;
    // redirections: [n]>, [n]>>, <, n>&m
    if (c === '>' || c === '<') {
      let fd = '';
      if (word != null && /^\d$/.test(word) && !quoted) { fd = word; word = null; }
      else flush();
      let op = c; i++;
      if (c === '>' && s[i] === '>') { op = '>>'; i++; }
      if (s[i] === '&') { op += '&'; i++; }
      while (s[i] === ' ' || s[i] === '\t') i++;
      let target = '';
      while (i < s.length && !' \t;&|<>()'.includes(s[i])) { target += s[i]; i++; }
      toks.push({ t: 'redir', v: op, fd, target });
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) { flush(); toks.push({ t: 'op', v: op }); i += op.length; continue; }
    word = (word || '') + c; i++;
  }
  flush();
  return { toks };
}

// Split into commands at the operators. Each segment keeps its words and its
// redirections; `ops` lists the operators between segments.
export function segments(toks) {
  const segs = [{ words: [], redirs: [] }]; const ops = [];
  for (const t of toks) {
    if (t.t === 'op') { ops.push(t.v); segs.push({ words: [], redirs: [] }); continue; }
    if (t.t === 'redir') { segs[segs.length - 1].redirs.push(t); continue; }
    segs[segs.length - 1].words.push(t);
  }
  return { segs: segs.filter((g) => g.words.length || g.redirs.length), ops };
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = (p) => P.basename(String(p || ''));

// ---- one crontab line ---------------------------------------------------------------

const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

// { kind: 'blank'|'comment'|'setting'|'reboot'|'job'|'unreadable', ... }
export function parseCronLine(text) {
  const raw = String(text == null ? '' : text);
  const line = raw.trim();
  if (!line) return { kind: 'blank' };
  if (line.startsWith('#')) return { kind: 'comment' };
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    return { kind: 'setting', name: m[1], value: m[2] };
  }
  if (/^@reboot\s/.test(line)) return { kind: 'reboot', command: line.replace(/^@reboot\s+/, '') };
  const mac = line.match(/^(@[a-z]+)\s+(.*)$/);
  if (mac) {
    if (!MACROS[mac[1]]) return { kind: 'unreadable', reason: `${mac[1]} is not a schedule cron knows` };
    return { kind: 'job', fields: MACROS[mac[1]].split(' '), command: mac[2], macro: mac[1] };
  }
  const parts = line.split(/\s+/);
  if (parts.length < 6) return { kind: 'unreadable', reason: 'it does not have five schedule fields and a command' };
  return { kind: 'job', fields: parts.slice(0, 5), command: line.replace(/^(\S+\s+){5}/, '') };
}

// ---- cron schedule -> cadence / scripts schedule -----------------------------------------

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// A cron field as a sorted list of numbers, or null when unreadable.
export function cronField(f, lo, hi, names = {}) {
  const out = new Set();
  for (const part of String(f).split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i);
    if (!m) return null;
    const num = (x) => { const k = x.toLowerCase(); if (k in names) return names[k]; return /^\d+$/.test(x) ? Number(x) : NaN; };
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { const [x, y] = m[1].split('-'); a = num(x); b = num(y); }
    else { a = num(m[1]); b = m[2] ? hi : a; }
    const step = m[2] ? Number(m[2]) : 1;
    if (!Number.isInteger(a) || !Number.isInteger(b) || !step || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

const pad = (n) => String(n).padStart(2, '0');
const MAX_TIMES = 48;

// { schedule, exact, note }. `floor` is the smallest "every N minutes" the
// target allows (30 for a skill, 1 for a script). An inexact carry-over is
// still a valid schedule, and its note says what changed.
export function cronToSchedule(fields, { floor = 1, todayYmd = '2026-01-01' } = {}) {
  const [fm, fh, fdom, fmon, fdow] = fields;
  const mins = cronField(fm, 0, 59);
  const hours = cronField(fh, 0, 23);
  const dows = cronField(String(fdow).replace(/\b7\b/g, '0'), 0, 6, DOW_NAMES);
  const anyDom = fdom === '*', anyMon = fmon === '*';
  if (!mins || !hours || !dows || (!anyDom && !cronField(fdom, 1, 31)) || (!anyMon && !cronField(fmon, 1, 12, MON_NAMES))) {
    return { schedule: { kind: 'times', days: [], times: ['03:00'] }, exact: false,
      note: `Crads-AI could not read the schedule "${fields.join(' ')}", so it is set to 03:00 every day for now. Set the real time before switching it on.` };
  }
  const days = fdow === '*' ? [] : dows.map((d) => DOW[d]);
  const notes = [];
  // Day of the month or a month: Crads-AI schedules by weekday or every few days.
  if (!anyDom || !anyMon) {
    const t = `${pad(hours[0])}:${pad(mins[0])}`;
    const dom = cronField(fdom, 1, 31);
    if (anyMon && dom && dom.length === 1 && fdow === '*') {
      const [y, mo, d] = todayYmd.split('-').map(Number);
      let ay = y, am = mo;
      if (d > dom[0]) { am += 1; if (am > 12) { am = 1; ay += 1; } }
      const anchor = `${ay}-${pad(am)}-${pad(Math.min(dom[0], 28))}`;
      return { schedule: { kind: 'every-days', n: 30, time: t, anchor }, exact: false,
        note: `Your server runs it on day ${dom[0]} of each month. Crads-AI cannot say "day ${dom[0]}", so it is set to every 30 days at ${t} from ${anchor}. Check that suits it before switching it on.` };
    }
    notes.push(`your server also limits it by day of the month or by month ("${fdom} ${fmon}"), which Crads-AI cannot, so check how often it should run before switching it on`);
  }
  // Every N minutes, all day.
  if (fh === '*' && /^\*\/\d+$/.test(fm) && fdow === '*' && anyDom && anyMon) {
    const n = Number(fm.slice(2));
    if (60 % n === 0) {
      if (n >= floor) return { schedule: { kind: 'every', minutes: n, quiet: false }, exact: true, note: '' };
      return { schedule: { kind: 'every', minutes: floor, quiet: false }, exact: false,
        note: `Your server runs it every ${n} minutes. A scheduled skill uses your Claude plan each time, so Crads-AI runs one at most every ${floor} minutes; it is set to every ${floor}.` };
    }
  }
  if (fm === '*' && fh === '*' && fdow === '*' && anyDom && anyMon) {
    if (floor <= 1) return { schedule: { kind: 'every', minutes: 1, quiet: false }, exact: true, note: '' };
    return { schedule: { kind: 'every', minutes: floor, quiet: false }, exact: false,
      note: `Your server runs it every minute; a scheduled skill runs at most every ${floor} minutes, so it is set to every ${floor}.` };
  }
  const times = [];
  for (const h of hours) for (const m of mins) times.push(`${pad(h)}:${pad(m)}`);
  if (times.length > MAX_TIMES) {
    const gap = Math.max(floor, Math.round(1440 / times.length));
    return { schedule: { kind: 'every', minutes: gap, quiet: false }, exact: false,
      note: `Your server runs it ${times.length} times a day; that many fixed times will not fit, so it is set to every ${gap} minutes.` };
  }
  // A skill on fixed times closer together than the floor is still allowed by
  // cadence (only "every" has a floor), and it is what the server does.
  return { schedule: { kind: 'times', days, times }, exact: notes.length === 0, note: notes.length ? `Note: ${notes.join('; ')}.` : '' };
}

// ---- what a command is ----------------------------------------------------------------------

const VALUED_CLAUDE_FLAGS = new Set(['--model', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
  '--output-format', '--input-format', '--max-turns', '--append-system-prompt', '--system-prompt', '--permission-mode',
  '--add-dir', '--mcp-config', '--resume', '-r', '--session-id', '--settings', '--agents', '--fallback-model']);
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'python', 'python3', 'bash', 'sh', 'zsh', 'perl', 'ruby']);
export const RUNNER_RE = /^(run[-_]?jobs?|jobs?[-_]?run(?:ner)?)\.(m?js|cjs|ts)$/i;

function claudeIn(words) {
  // `claude ... -p "<prompt>"`, `claude --print "<prompt>"`, `claude -p` with the prompt later
  if (!words.length || base(words[0].v) !== 'claude') return null;
  const args = words.slice(1);
  if (!args.some((w) => w.v === '-p' || w.v === '--print' || /^-[a-z]*p$/.test(w.v))) return null;
  const flags = [];
  let prompt = null, promptExpands = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '-p' || v === '--print' || /^-[a-z]*p$/.test(v)) continue;
    if (v.startsWith('-')) {
      const k = v.split('=')[0];
      flags.push(k);
      if (VALUED_CLAUDE_FLAGS.has(k) && !v.includes('=')) i++;
      continue;
    }
    if (prompt == null) { prompt = v; promptExpands = !!args[i].expands; }
  }
  return { prompt, promptExpands, flags };
}

// Everything the planner needs to know about a cron command, conservatively.
// Returns { simple, cwdHost, env, argv, redirs, claude, runner, complexWhy, error }.
export function analyzeCommand(command, { login = 'root' } = {}) {
  const out = { simple: false, cwdHost: homeOf(login), env: [], argv: [], redirs: [], claude: null, runner: null, complexWhy: '', percent: false };
  let cmd = String(command);
  // In a crontab an unescaped % ends the command and starts its stdin.
  if (/(^|[^\\])%/.test(cmd)) { out.percent = true; }
  cmd = cmd.replace(/\\%/g, '%');
  const tk = tokenize(cmd);
  if (tk.error) { out.error = tk.error; out.complexWhy = `it has ${tk.error}`; return out; }
  const { segs, ops } = segments(tk.toks);
  for (const g of segs) {
    const words = g.words.filter((w, i) => !(ASSIGN_RE.test(w.v) && g.words.slice(0, i).every((x) => ASSIGN_RE.test(x.v))));
    const c = claudeIn(words);
    if (c) { out.claude = c; break; }
  }
  // the simple shape: [cd DIR &&] [NAME=value ...] program args [redirections]
  let main = segs;
  if (segs.length === 2 && ops[0] === '&&' && segs[0].words.length === 2 && segs[0].words[0].v === 'cd' && !segs[0].redirs.length) {
    const dir = segs[0].words[1];
    if (!dir.expands || /^\$\{?HOME\}?/.test(dir.v)) out.cwdHost = P.resolve(homeOf(login), expandHome(dir.v, login));
    else { out.complexWhy = 'its folder is worked out by the shell'; }
    main = [segs[1]];
  } else if (segs.length !== 1) {
    out.complexWhy = ops.includes('|') ? 'it pipes one program into another'
      : ops.some((o) => o === '&&' || o === '||' || o === ';') ? 'it runs several commands in a row' : 'it uses shell features';
  }
  if (out.percent && !out.complexWhy) out.complexWhy = 'it uses %, which cron turns into input for the command';
  if (!out.complexWhy && main.length === 1) {
    const g = main[0];
    const words = [...g.words];
    while (words.length && ASSIGN_RE.test(words[0].v) && !words[0].quoted) {
      const w = words.shift();
      if (w.expands && !/\$\{?HOME\}?/.test(w.v)) { out.complexWhy = 'it sets a variable the shell works out'; break; }
      out.env.push(expandHome(w.v, login));
    }
    if (!out.complexWhy) {
      if (!words.length) out.complexWhy = 'it only sets variables';
      else if (words.some((w) => w.expands && !/^\$\{?HOME\}?(\/|$)/.test(w.v))) out.complexWhy = 'it uses variables the shell fills in';
      else if (words.some((w) => !w.quoted && /[*?[]/.test(w.v))) out.complexWhy = 'it uses a wildcard the shell expands';
      else if (g.redirs.some((r) => r.v === '<')) out.complexWhy = 'it reads its input from a file';
    }
    if (!out.complexWhy) {
      out.simple = true;
      out.argv = words.map((w) => (w.quoted ? w.v : expandHome(w.v, login)));
      out.redirs = g.redirs.map((r) => `${r.fd}${r.v}${r.target}`);
      const a0 = base(out.argv[0]);
      const script = INTERPRETERS.has(a0) ? out.argv.find((x, i) => i > 0 && !x.startsWith('-')) : out.argv[0];
      if (script && RUNNER_RE.test(base(script))) {
        const at = out.argv.indexOf(script);
        const job = out.argv.slice(at + 1).find((x) => !x.startsWith('-'));
        if (job) out.runner = { script, job };
      }
    }
  }
  return out;
}

// ---- job runner definitions ----------------------------------------------------------------
// The runner's own file is read as TEXT, never executed. JSON is parsed; a
// JS/MJS module is scanned for the job's object literal. Answers
// { found, claude, prompt (a plain string or null), skill, why }.

function blockAt(text, open) {
  // the balanced {...} starting at `open`, skipping strings and comments
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { const j = text.indexOf('\n', i); i = j < 0 ? text.length : j; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 1; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fromEntry(e, job) {
  const prompt = typeof e.prompt === 'string' ? e.prompt : null;
  const skill = typeof e.skill === 'string' ? e.skill : null;
  if (prompt != null || skill != null || e.prompt) {
    return { found: true, claude: true, prompt, skill, why: `its definition for ${job} carries ${skill ? 'a skill' : 'a prompt'}` };
  }
  return { found: true, claude: false, prompt: null, skill: null, why: `its definition for ${job} has no prompt, so it runs a program` };
}

export function readJobDefinition(text, file, job) {
  const src = String(text || '');
  if (/\.json$/i.test(file)) {
    let j; try { j = JSON.parse(src); } catch { return { found: false, why: `${base(file)} is not readable JSON` }; }
    const pool = j && typeof j === 'object' && j.jobs ? j.jobs : j;
    let e = null;
    if (Array.isArray(pool)) e = pool.find((x) => x && (x.name === job || x.id === job));
    else if (pool && typeof pool === 'object') e = pool[job];
    if (!e || typeof e !== 'object') return { found: false, why: `${base(file)} has no job called ${job}` };
    return fromEntry(e, job);
  }
  // keyed: `job: {`, `'job': {`, `"job": {`   or  `{ name: 'job', ... }`
  const keyed = new RegExp(`(?:^|[\\s,{])(['"]?)${escRe(job)}\\1\\s*:\\s*\\{`, 'm').exec(src);
  let block = null;
  if (keyed) block = blockAt(src, keyed.index + keyed[0].length - 1);
  if (!block) {
    const named = new RegExp(`\\b(?:name|id)\\s*:\\s*(['"\`])${escRe(job)}\\1`).exec(src);
    if (named) {
      // walk back to the opening brace of the object holding it
      let depth = 0, i = named.index;
      for (; i >= 0; i--) { if (src[i] === '}') depth++; if (src[i] === '{') { if (depth === 0) break; depth--; } }
      if (i >= 0) block = blockAt(src, i);
    }
  }
  if (!block) return { found: false, why: `${base(file)} has no job called ${job} that could be read` };
  // `prompt: ...`, or a method `prompt(ctx) { ... }` / `async prompt(...)`
  const hasPrompt = /\bprompt\s*(:|\()/.test(block);
  const sk = block.match(/\bskill\s*:\s*(['"`])([A-Za-z0-9_-]+)\1/);
  if (!hasPrompt && !sk) return { found: true, claude: false, prompt: null, skill: null, why: `its definition for ${job} has no prompt, so it runs a program` };
  let prompt = null;
  const pm = block.match(/\bprompt\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/);
  if (pm && !(pm[1] === '`' && pm[2].includes('${'))) prompt = pm[2].replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');
  return { found: true, claude: true, prompt, skill: sk ? sk[2] : null,
    why: `its definition for ${job} carries ${sk ? 'a skill' : 'a prompt'}${hasPrompt && prompt == null ? ' that is built when it runs, so the plan could not copy its words' : ''}` };
}

// A prompt that is only `/name` names a skill.
export function slashSkill(prompt) {
  const m = String(prompt || '').trim().match(/^\/([A-Za-z0-9][A-Za-z0-9_-]{0,62})$/);
  return m ? m[1] : null;
}

// ---- the Telegram program ------------------------------------------------------------------
// What the host program does that Crads-AI's own Telegram reader does not, read
// from its code. Crads-AI today: text in, a draft reply out with Approve and
// Deny, and sending from scheduled jobs.
const TG_FEATURES = [
  [/sendVoice|\bvoice\b|\.ogg\b|whisper|transcri/i, 'voice notes'],
  [/sendPhoto|sendDocument|\bphoto\b/i, 'photos and files'],
  [/inline_keyboard|callback_query/, 'buttons on its own messages (Crads-AI has Approve and Deny on its drafts only)'],
  [/driving|hands-?free/i, 'a hands-free driving mode'],
  [/\bcost\b|budget|ceiling|spend/i, 'a daily spending limit'],
  [/--resume|resumeSession|session[_-]?id/i, 'carrying a conversation on from where it stopped'],
];
export function telegramGap(source) {
  if (source == null) return null;
  return TG_FEATURES.filter(([re]) => re.test(String(source))).map(([, words]) => words);
}

export function isTelegramish(s) { return /telegram|tg[-_]?bot|\btg-chat\b/i.test(String(s || '')); }

// Who reads the bot RIGHT NOW, in words, from the plan and the mineral's own
// flags. The page's Telegram line is this and nothing else, so it can never say
// "answered by Crads-AI" while nothing is reading (adopt rehearsal T4 finding 5).
// While moving in, Crads-AI's comms are held back entirely: it neither reads
// nor sends. After Finish, with the person's own program still answering,
// Crads-AI can send (a job's "Send me the result") but never reads.
export function telegramNow(plan, { movingIn = false } = {}) {
  const t = (plan && plan.telegram) || {};
  if (!t.env_file) return { who: 'none', words: '' };
  const steps = (plan && plan.steps) || [];
  const cut = steps.find((s) => s.id === 'telegram-cutover');
  if (cut && cut.in_flight) {
    return { who: 'unclear', words: 'Telegram: switching who answers your bot stopped part way through, so the app does not know yet who reads it. Check that step below.' };
  }
  if (t.answered_by === 'crads') {
    return movingIn
      ? { who: 'nobody', words: 'Telegram: nobody answers your bot right now. Your own program on the server is switched off, and Crads-AI reads nothing until you finish moving in. Undo "Let Crads-AI answer your Telegram bot" to bring your program back.' }
      : { who: 'crads', words: 'Telegram: Crads-AI answers your bot. Your own program on the server is switched off.' };
  }
  if (!cut) {
    return { who: 'unknown', words: t.carried
      ? 'Telegram: Crads-AI holds your bot\'s details but does not read it. The plan found no program of yours on the server that answers it.'
      : 'Telegram: the plan found your bot\'s details, but no program of yours on the server that answers it.' };
  }
  if (!t.carried) return { who: 'host', words: 'Telegram: your own program on the server answers your bot. Crads-AI does not have the bot\'s details yet.' };
  return movingIn
    ? { who: 'host', words: 'Telegram: your own program on the server answers your bot. Crads-AI holds its details and sends nothing while you are moving in.' }
    : { who: 'host', words: 'Telegram: your own program on the server answers your bot. Crads-AI reads nothing, and sends you the results of jobs set to "Send me the result".' };
}

// ---- the brain's git remote ----------------------------------------------------------------
// Where Crads-AI's nightly push would go, read from the brain's own git config
// (the inventory names the remote, never its URL: a URL can carry a token).

// The url of remote `name` in a .git/config text, or ''.
export function parseGitRemoteUrl(configText, name = 'origin') {
  let inRemote = false;
  for (const raw of String(configText || '').split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[\s*remote\s+"([^"]*)"\s*\]$/);
    if (sec) { inRemote = sec[1] === name; continue; }
    if (/^\[/.test(line)) { inRemote = false; continue; }
    const kv = inRemote && line.match(/^url\s*=\s*(.*)$/);
    if (kv) return kv[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}

// Can a program inside the mineral use this remote at all? Two shapes cannot,
// whatever is signed in: a host name only the server's own ~/.ssh/config knows
// (`git@github-brain:me/brain.git`), and a folder on the server. Answers
// { usable: true|false|null, kind, why } (null: there is no remote).
export function remoteReach(url) {
  const u = String(url || '').trim();
  if (!u) return { usable: null, kind: 'none', why: 'there is no remote' };
  if (/^(file:\/\/|\/|\.{1,2}\/|~)/.test(u)) {
    return { usable: false, kind: 'path', why: 'it is a folder on your server, which your mineral cannot see' };
  }
  let host = '';
  const ssh = u.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i);
  const scp = u.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/\/)/);
  if (ssh) host = ssh[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { usable: true, kind: 'url', why: '' };
  else if (scp) host = scp[1];
  else return { usable: false, kind: 'path', why: 'it is a folder on your server, which your mineral cannot see' };
  if (!host.includes('.')) {
    return { usable: false, kind: 'alias', why: `it names "${host}", a server name that only your server's own SSH settings know` };
  }
  return { usable: true, kind: 'ssh', why: '' };
}

// ---- MCP servers ---------------------------------------------------------------------------
// Where a server can run, from its .mcp.json entry and what the container has.
// `has(name)` answers "is this program inside the mineral"; `inBrain(p)`
// translates a host path inside the brain (null when outside).
export function mcpPlace(entry, { has, inBrain, exists }) {
  if (!entry || typeof entry !== 'object') return { place: 'unknown', why: 'its settings could not be read' };
  if (entry.url || entry.type === 'http' || entry.type === 'sse') {
    // A loopback address is a program on the server itself. Inside the mineral,
    // localhost is the mineral, so it cannot be reached from there (shadow test
    // on Oracle, 2026-10-19: google_workspace at http://localhost:8000/mcp was
    // called "reached over the internet").
    const lp = loopbackOf(entry.url);
    if (lp) return { place: 'host', why: `it is a program on your server itself (${lp}); inside your mineral, localhost is the mineral, so it cannot reach it` };
    return { place: 'container', why: 'it is reached over the internet, which works from inside your mineral' };
  }
  const cmd = String(entry.command || '');
  if (!cmd) return { place: 'unknown', why: 'it names no program' };
  const b = base(cmd);
  if (b === 'docker' || b === 'podman') return { place: 'host', why: `it starts a ${b} container, and your mineral cannot start containers` };
  // An absolute path in its arguments that is outside the brain folder is
  // somewhere the mineral cannot see (the WhatsApp server runs from a folder
  // on the server, not from the brain the mineral was given).
  for (const a of Array.isArray(entry.args) ? entry.args : []) {
    const v = String(a);
    if (P.isAbsolute(v) && !inBrain(v)) return { place: 'host', why: `it uses ${v}, which is outside your brain folder, so your mineral cannot see it` };
  }
  if (b === 'uvx' || b === 'uv') return has(b) ? { place: 'container', why: `${b} is inside your mineral` } : { place: 'image', why: `it needs ${b}, which your mineral does not have yet` };
  if (P.isAbsolute(cmd)) {
    const c = inBrain(cmd);
    if (c && exists(c)) return { place: 'container', why: 'its program is inside your brain folder' };
    if (has(b) && INTERPRETERS.has(b)) return { place: 'container', why: `${b} is inside your mineral (your server's copy lives at ${cmd})` };
    return { place: 'host', why: `its program ${cmd} is only on your server` };
  }
  if (has(b)) return { place: 'container', why: `${b} is inside your mineral` };
  return { place: 'image', why: `it needs ${b}, which your mineral does not have yet` };
}

// "localhost:8000" when a URL points at the machine itself, else null.
export function loopbackOf(url) {
  let u; try { u = new URL(String(url || '')); } catch { return null; }
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || /^127\./.test(h)) return `${h}${u.port ? ':' + u.port : ''}`;
  return null;
}

export function envRefs(entry) {
  const refs = new Set();
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) refs.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(entry);
  return [...refs].sort();
}

// ---- hooks ---------------------------------------------------------------------------------
export function hookInterpreter(file, firstLine = '') {
  const sb = String(firstLine).match(/^#!\s*(\S+)(?:\s+(\S+))?/);
  if (sb) return base(sb[1]) === 'env' ? (sb[2] || 'sh') : base(sb[1]);
  if (/\.py$/.test(file)) return 'python3';
  if (/\.(m?js|cjs)$/.test(file)) return 'node';
  if (/\.sh$/.test(file)) return 'bash';
  return null;
}

// ---- crontab text: the allow-listed host edits --------------------------------------------------
// Pure, shared by the app (which runs them over SSH) and the tests. A crontab
// is edited only by commenting ONE line that matches exactly, and un-commenting
// ONE line that carries exactly our prefix. Anything else is refused.

export const commentPrefix = (ymd) => `${COMMENT_TAG} ${ymd}: `;

function splitKeep(text) {
  const s = String(text);
  const lines = s.split('\n');
  const endsNl = s.endsWith('\n');
  if (endsNl) lines.pop();
  return { lines, endsNl };
}
const join = ({ lines, endsNl }) => lines.join('\n') + (endsNl ? '\n' : '');

export function commentCronLine(text, lineText, ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return { ok: false, reason: 'the date is not a date' };
  if (typeof lineText !== 'string' || !lineText.trim() || lineText.includes('\n')) return { ok: false, reason: 'the line to switch off is empty or spans lines' };
  const doc = splitKeep(text);
  const hits = doc.lines.map((l, i) => (l === lineText ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) {
    return { ok: false, reason: hits.length ? `that line appears ${hits.length} times in the crontab, so the app will not guess which one to switch off`
      : 'that line is no longer in the crontab exactly as it was, so the app changed nothing' };
  }
  doc.lines[hits[0]] = commentPrefix(ymd) + lineText;
  return { ok: true, text: join(doc), line_no: hits[0] + 1 };
}

export function uncommentCronLine(text, lineText, ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return { ok: false, reason: 'the date is not a date' };
  const want = commentPrefix(ymd) + lineText;
  const doc = splitKeep(text);
  const hits = doc.lines.map((l, i) => (l === want ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) {
    return { ok: false, reason: hits.length ? `the switched-off line appears ${hits.length} times, so the app will not guess which one to put back`
      : 'the switched-off line is not in the crontab any more, so the app changed nothing' };
  }
  doc.lines[hits[0]] = lineText;
  return { ok: true, text: join(doc), line_no: hits[0] + 1 };
}
