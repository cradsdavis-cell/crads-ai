// local-bridge.mjs: the no-server face's transport (2026-09-11). Same
// injectable shape systemBridge() hands the panel server ({targets, stream}),
// against a brain folder on this computer instead of a box over ssh.
//
// Two kinds of command ride stream():
//
//   1. A LOCAL VERB, `__local__ {"verb":...,"args":...}` (local-verbs.mjs
//      LOCAL_MARK). Runs IN THIS PROCESS. The box verbs shell `node
//      /app/engine/...` and POSIX `find | sed | base64`; a member's Windows
//      laptop has neither a POSIX userland nor, inside the packaged exe, a
//      `node` it can spawn (the exe is a single-executable node whose main is
//      fixed). So anything that needs the engine or the filesystem runs as a
//      JS function here, and the shell path below is kept for the one verb
//      that is a plain command (whoami) and for anything a future verb wants
//      to shell honestly.
//   2. ANYTHING ELSE is a shell line, run with cwd = the brain folder:
//      `bash -lc <cmd>` on linux/darwin, `cmd.exe /d /s /c <cmd>` on win32.
//      Line-framed through the same lineWire ssh-bridge uses, opts.stdin
//      written then closed, opts.hardTimeoutMs watchdog (25s default, same as
//      ssh), 'close' with the exit code. The shell choice is explicit and
//      tested (shellFor) because most of the people this face is for are on
//      Windows.
//
// NO tty. A terminal on the member's own computer is their own terminal; the
// panel's /term/open refuses a local target in words and the Help page points
// at Claude Code on the folder instead.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lineWire } from './ssh-bridge.mjs';
import { LOCAL_MARK, runLocalVerb } from './local-verbs.mjs';

export function shellFor(platform = process.platform) {
  if (platform === 'win32') return { exe: process.env.ComSpec || 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', cmd] };
  return { exe: 'bash', args: (cmd) => ['-lc', cmd] };
}

// A pebble-shaped handle: on('close'|'error'), kill(). The in-process path
// resolves through it too, so the panel's two call sites see one shape.
function handle() {
  const ee = new EventEmitter();
  ee.kill = () => { ee.killed = true; };
  return ee;
}

function fail(h, opts, line, code = 1) {
  setImmediate(() => { if (opts.onStderr) opts.onStderr(line); h.emit('close', code); });
  return h;
}

/**
 * @param {object} o
 *   targets   () => local target rows (listLocalTargets)
 *   assets    the engine assets bag (local-scaffold loadEngineAssets), for the
 *             verbs that seed or sync from the engine
 *   platform  test override for the shell choice
 */
export function localBridge({ targets = () => [], assets = null, platform = process.platform } = {}) {
  const shell = shellFor(platform);
  return {
    targets: () => { try { return targets() || []; } catch { return []; } },
    stream(host, command, opts = {}) {
      const h = handle();
      const t = (() => { try { return (targets() || []).find((x) => x && x.host === host); } catch { return null; } })();
      if (!t) return fail(h, opts, `no local brain called ${String(host).slice(0, 60)} on this computer`);
      const cmd = String(command ?? '');
      if (cmd.startsWith(LOCAL_MARK)) {
        let spec;
        try { spec = JSON.parse(cmd.slice(LOCAL_MARK.length)); } catch { return fail(h, opts, 'unreadable local verb'); }
        const emit = (line) => { if (opts.onStdout) opts.onStdout(String(line)); };
        const emitErr = (line) => { if (opts.onStderr) opts.onStderr(String(line)); };
        Promise.resolve()
          .then(() => runLocalVerb(t, spec.verb, spec.args || {}, { emit, emitErr, stdin: opts.stdin, assets }))
          .then((code) => h.emit('close', h.killed ? -1 : (Number.isInteger(code) ? code : 0)),
            (e) => { emitErr(`ERROR: ${e && e.message ? e.message : e}`); h.emit('close', 1); });
        return h;
      }
      let real;
      try {
        real = spawn(shell.exe, shell.args(cmd), { cwd: t.path, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) { return fail(h, opts, `could not start a shell on this computer: ${e.message || e}`); }
      const HARD_MS = Number(opts.hardTimeoutMs ?? process.env.AIOS_SSH_HARD_TIMEOUT ?? 25000);
      const wd = HARD_MS > 0 ? setTimeout(() => {
        try { real.kill('SIGKILL'); } catch { /* gone */ }
        if (opts.onStderr) opts.onStderr(`local command exceeded ${HARD_MS}ms; killed`);
      }, HARD_MS) : null;
      if (opts.onStdout) lineWire(real.stdout, opts.onStdout);
      if (opts.onStderr) lineWire(real.stderr, opts.onStderr);
      real.on('error', (e) => { if (wd) clearTimeout(wd); h.emit('error', e); });
      real.on('close', (code) => { if (wd) clearTimeout(wd); h.emit('close', code ?? 1); });
      try {
        if (opts.stdin !== undefined) real.stdin.write(opts.stdin);
        real.stdin.end();
      } catch { /* dying spawn */ }
      h.kill = (sig) => { h.killed = true; try { real.kill(sig); } catch { /* gone */ } };
      return h;
    },
  };
}

// ONE bridge for the one panel server. The panel's gates already switch on
// the target's kind, so the transport only has to route: a host that is a
// local target streams locally, everything else goes over ssh, and a tty is
// only ever the ssh side's (panel-server refuses /term/open for a local kind
// before it would reach here). app.mjs composes this; tests compose their own.
export function composeBridge({ ssh, local }) {
  const localTargets = () => { try { return local.targets() || []; } catch { return []; } };
  const isLocal = (host) => localTargets().some((t) => t.host === host);
  const out = {
    targets: () => {
      let a = []; let b = [];
      try { a = ssh.targets() || []; } catch { a = []; }
      b = localTargets();
      return [...a, ...b];
    },
    stream: (host, command, o = {}) => (isLocal(host) ? local.stream(host, command, o) : ssh.stream(host, command, o)),
  };
  if (ssh.tty) out.tty = (host, o = {}) => ssh.tty(host, o);
  return out;
}
