// host-ops.mjs: the ONLY two things /move-in may change on the server itself
// (spec 2026-10-17-adopt-existing-server.md § 3, cutover step (c)).
//
//   cron-comment  {user, line_text, ymd}   comment ONE crontab line that matches
//                                          exactly, with `# crads-move-in <ymd>: `;
//                                          undo removes exactly that prefix
//   unit-disable  {name, scope, user}      systemctl [--user] disable --now;
//                                          undo puts back what was there before
//
// Each op also has a read-only `check` form (action: 'check'), used when the
// app stopped half way through a step: cron-comment reads the crontab and
// counts the line plain and commented; unit-disable asks systemd is-enabled and
// is-active. A check changes nothing on the server.
//
// Nothing else exists. There is no op that takes a command, a path or a script
// from the plan or the page: each op is a fixed script here, and its arguments
// travel inside it as base64 literals (an alphabet with no shell meaning), so a
// crontab line full of quotes and `$(...)` is data, never code. The app runs
// these over SSH as the server login (wizard/panel/move-in-host.mjs), the
// container never does: the container holds the plan, the server holds the
// crontab, and only the person's app holds a key to the server.
//
// Pure: builds scripts and reads their answers. The crontab edit itself is
// lib.mjs commentCronLine / uncommentCronLine, computed by the caller between a
// read and a guarded write, so the text that lands is the text that was checked.
import { createHash } from 'node:crypto';
import { commentCronLine, uncommentCronLine } from './lib.mjs';

export const HOST_OPS = ['cron-comment', 'unit-disable'];
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,120}\.(?:service|timer)$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = {
  'cron-comment': ['op', 'action', 'user', 'line_text', 'ymd'],
  'unit-disable': ['op', 'action', 'name', 'scope', 'user', 'prior'],
};

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// null when the op is one of the two and every argument has its shape, else
// the reason. Run by the app on whatever the box hands it, before anything
// reaches the server: the box is trusted to plan, not to say what runs.
export function validateHostOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'the server step is not readable';
  if (!HOST_OPS.includes(op.op)) return `"${String(op.op).slice(0, 30)}" is not something the move-in may do on your server`;
  for (const k of Object.keys(op)) if (!KEYS[op.op].includes(k)) return `a server step may not carry "${k.slice(0, 30)}"`;
  if (op.action !== 'apply' && op.action !== 'undo' && op.action !== 'check') return 'a server step is done, undone or checked';
  if (!USER_RE.test(String(op.user || ''))) return 'the server login is not a Linux user name';
  if (op.op === 'cron-comment') {
    if (typeof op.line_text !== 'string' || !op.line_text.trim() || op.line_text.length > 4096 || /[\n\r\0]/.test(op.line_text)) return 'the crontab line is empty, too long or spans lines';
    if (!YMD_RE.test(String(op.ymd || ''))) return 'the date is not a date';
    return null;
  }
  if (!UNIT_RE.test(String(op.name || ''))) return 'that is not a systemd service name';
  if (op.scope !== 'system' && op.scope !== 'user') return 'a service is either a system one or a user one';
  if (op.action === 'undo') {
    const p = op.prior;
    if (!p || typeof p !== 'object' || typeof p.enabled !== 'string' || typeof p.active !== 'string') return 'undoing needs what the service was doing before';
  } else if (op.prior != null) return 'a new switch-off or a check carries no earlier state';
  return null;
}

// Runs what it is given as root: directly when the login is root, through
// passwordless sudo otherwise (the same door own-server.mjs uses). The script
// arrives on stdin, never in argv.
export const AS_ROOT = 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi';

const lit = (name, value) => `${name}="$(printf %s '${b64(value)}' | base64 -d)"`;

// ---- cron ------------------------------------------------------------------------
export function cronReadScript(user) {
  return [
    'set -u', lit('U', user),
    'id -u "$U" >/dev/null 2>&1 || { echo "MOVEIN_ERR there is no login called $U on this server"; exit 3; }',
    // `crontab -l` fails on a login with no crontab; that is an empty one.
    'C="$(crontab -l -u "$U" 2>/dev/null | base64 -w0)"',
    'echo "CRONTAB ${C}"',
  ].join('\n') + '\n';
}

export function cronWriteScript(user, expectSha, nextText) {
  return [
    'set -u', lit('U', user),
    `CUR="$(crontab -l -u "$U" 2>/dev/null | sha256sum | cut -d' ' -f1)"`,
    `[ "$CUR" = "${expectSha}" ] || { echo "MOVEIN_ERR the crontab changed while the app was reading it, so nothing was written"; exit 4; }`,
    `printf %s '${b64(nextText)}' | base64 -d | crontab -u "$U" - || { echo "MOVEIN_ERR crontab refused the change"; exit 5; }`,
    `echo "WROTE $(crontab -l -u "$U" 2>/dev/null | sha256sum | cut -d' ' -f1)"`,
  ].join('\n') + '\n';
}

export function parseCrontabAnswer(stdout) {
  const m = String(stdout || '').match(/^CRONTAB ?([A-Za-z0-9+/=]*)\s*$/m);
  if (!m) return null;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

// What the edit turns `text` into, or why not.
export function cronEdit(op, text) {
  return op.action === 'apply' ? commentCronLine(text, op.line_text, op.ymd) : uncommentCronLine(text, op.line_text, op.ymd);
}

// ---- systemd ----------------------------------------------------------------------------
const SYSD = [
  'sysd(){',
  '  if [ "$S" = user ]; then',
  '    UID_="$(id -u "$U")" || return 9',
  '    if [ "$(id -u)" = "$UID_" ]; then XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_}" systemctl --user "$@";',
  '    else runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$UID_" systemctl --user "$@"; fi',
  '  else systemctl "$@"; fi',
  '}',
];

export function unitScript(op) {
  const head = ['set -u', lit('N', op.name), lit('S', op.scope), lit('U', op.user), ...SYSD];
  if (op.action === 'apply') {
    return [...head,
      'EN="$(sysd is-enabled "$N" 2>/dev/null)"; [ -n "$EN" ] || EN=unknown',
      'AC="$(sysd is-active "$N" 2>/dev/null)"; [ -n "$AC" ] || AC=unknown',
      'echo "PRIOR $EN $AC"',
      'sysd disable --now "$N" >/dev/null 2>&1 || { echo "MOVEIN_ERR systemd would not switch $N off"; exit 5; }',
      'echo "DONE $(sysd is-active "$N" 2>/dev/null)"',
    ].join('\n') + '\n';
  }
  // Undo puts back what was there: enabled again if it was, running again if it was.
  return [...head,
    lit('PE', op.prior.enabled), lit('PA', op.prior.active),
    'case "$PE" in enabled|enabled-runtime) sysd enable "$N" >/dev/null 2>&1 || { echo "MOVEIN_ERR systemd would not switch $N back on"; exit 5; };; esac',
    'case "$PA" in active|activating|reloading) sysd start "$N" >/dev/null 2>&1 || { echo "MOVEIN_ERR systemd would not start $N"; exit 5; };; esac',
    'echo "DONE $(sysd is-active "$N" 2>/dev/null)"',
  ].join('\n') + '\n';
}

export function parseUnitAnswer(stdout) {
  const s = String(stdout || '');
  const p = s.match(/^PRIOR (\S+) (\S+)\s*$/m);
  const d = s.match(/^DONE ?(\S*)\s*$/m);
  return { prior: p ? { enabled: p[1], active: p[2] } : null, done: !!d, now: d ? d[1] : '' };
}

export function errOf(r) {
  const m = String((r && r.stdout) || '').match(/^MOVEIN_ERR (.*)$/m);
  if (m) return m[1];
  const e = String((r && r.stderr) || '').trim().split('\n').pop();
  return e || `the server answered with exit code ${r && r.code}`;
}

// ---- the read-only checks (a step the app stopped half way through) -----------------
// What the crontab shows for one line: how often it is there as it was, and how
// often with exactly our prefix and date.
export function cronCheck(text, lineText, ymd) {
  const lines = String(text || '').split('\n');
  const tagged = `# crads-move-in ${ymd}: ${lineText}`;
  return { plain: lines.filter((l) => l === lineText).length, commented: lines.filter((l) => l === tagged).length };
}

export function unitCheckScript(op) {
  return ['set -u', lit('N', op.name), lit('S', op.scope), lit('U', op.user), ...SYSD,
    'EN="$(sysd is-enabled "$N" 2>/dev/null)"; [ -n "$EN" ] || EN=unknown',
    'AC="$(sysd is-active "$N" 2>/dev/null)"; [ -n "$AC" ] || AC=unknown',
    'echo "STATE $EN $AC"',
  ].join('\n') + '\n';
}

export function parseUnitState(stdout) {
  const m = String(stdout || '').match(/^STATE (\S+) (\S+)\s*$/m);
  return m ? { enabled: m[1], active: m[2] } : null;
}
