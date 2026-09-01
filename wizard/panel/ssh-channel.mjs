// ssh-channel.mjs: a PERSISTENT framed command channel over one `ssh -tt` session.
//
// Why this exists (2026-08-14 lag audit, stage S2). The panel pays a full SSH
// handshake per verb. Measured against a QA rock at 249ms RTT:
//
//   discrete ssh, no multiplexing      3.38s per verb   (~13.5 round trips)
//   discrete ssh, ControlMaster reused 0.66s per verb   (~2.6 round trips)
//   this channel, warm, pooled x3      0.089s per verb
//
// ControlMaster is the obvious fix and ssh-bridge already asks for it, but
// `sshArgs()` guards it with `process.platform !== 'win32'` because Win32
// OpenSSH cannot multiplex. Windows is where the app actually runs, so the
// panel has never had connection reuse. This channel needs no ControlMaster:
// it holds ONE session open and feeds commands to its shell, so it works
// identically on Windows, macOS and Linux.
//
// It also beats ControlMaster, because the box's `ForceCommand enter-aios`
// re-enters the container on every exec. A held session is ALREADY inside the
// container, so per-verb container entry disappears too.
//
// FRAMING. Each command is wrapped so the client can find its boundaries and
// separate the streams, which a pty otherwise merges into one:
//
//   ( CMD ; __c=$?; printf 'N_ERREOF\n' 1>&2; exit $__c ) \
//     2> >(sed -u 's/^/N_E /') ; printf '\nN_END_%d\n' "$?"
//
//   - N is a fresh random nonce per command, so output containing a literal
//     sentinel cannot spoof a boundary (covered by a test).
//   - stderr is line-tagged live through a process substitution, so long verbs
//     keep streaming progress rather than buffering to the end.
//   - The subshell isolates cwd and env: command 2 does not inherit a `cd`.
//   - `__c` carries the real exit code across the barrier printf.
//
// TWO BARRIERS, NOT ONE. The `>(sed)` process flushes independently of the
// parent shell, so the END marker can and does overtake the tagged stderr:
// during development stderr from command N surfaced inside command N+1's
// window. A command is therefore complete only once BOTH the END marker and
// the tagged ERREOF line have arrived. Ordering BETWEEN the two streams is not
// guaranteed (two writers, one pty) and is not relied upon; only completeness.
//
// WHAT DOES NOT RIDE THE CHANNEL. A pty runs in canonical mode with a ~4KB
// line limit, so a large `opts.stdin` payload (file uploads arrive base64'd)
// would be truncated. Binary output cannot be line-framed at all. Both stay on
// the discrete path; see isChannelEligible() in ssh-bridge.mjs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ESC = String.fromCharCode(27);

// Strip the CSI sequences a shell emits on a pty (bracketed paste in
// particular: the prototype saw `ESC[?2004h` land in the first result).
export function stripAnsi(s) {
  return s
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9?;]*[a-zA-Z]/, '')))
    .join('');
}

// The command gets its OWN subshell; the barrier printf sits OUTSIDE it but
// still inside the redirected group. An earlier version put both in one
// subshell, and any command calling `exit` (a normal thing for a verb to do)
// killed that subshell before the barrier ran, so ERREOF never arrived and the
// call hung until the watchdog fired. Caught by the `exit 9` test.
//
// `{ ...; }` is a group, not a subshell, so `__c` survives to the END printf,
// while `( ... )` around the command still contains its cwd and env.
export function frameCommand(nonce, command) {
  return `{ ( ${command} ) ; __c=$?; printf '${nonce}_ERREOF\\n' 1>&2; } `
    + `2> >(sed -u 's/^/${nonce}_E /') ; printf '\\n${nonce}_END_%d\\n' "$__c"`;
}

const DEFAULT_OPEN_MS = 25000;
const DEFAULT_CMD_MS = 25000;

export class SshChannel {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.proc = null;
    this.buf = '';
    this.pending = null;      // in-flight command state
    this.dead = false;
    this.busy = false;
    this.openedAt = 0;
  }

  open() {
    if (this.proc) return this.readyPromise;
    const args = [...(this.opts.sshArgs || []), '-tt', this.host];
    this.proc = spawn(this.opts.sshExe || 'ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb' },
    });
    this.openedAt = Date.now();

    this.proc.stdout.on('data', (d) => this._ingest(String(d)));
    // Transport-level stderr (ssh's own complaints) never carries framing.
    this.proc.stderr.on('data', (d) => {
      const t = String(d);
      if (this.opts.onTransportError) this.opts.onTransportError(t);
      if (this.pending && this.pending.onStderr) {
        for (const l of t.split('\n')) if (l.trim()) this.pending.onStderr(l.replace(/\r$/, ''));
      }
    });
    const die = (why) => this._destroy(why);
    this.proc.on('close', () => die('channel closed'));
    this.proc.on('error', (e) => die(`channel error: ${e.message}`));

    // Quiet the shell: no echo of our own commands, no CR translation, no
    // bracketed paste, no prompt. Each of these showed up as noise in output.
    this._write("stty -echo -onlcr 2>/dev/null; unset PROMPT_COMMAND; PS1=''; "
      + "bind 'set enable-bracketed-paste off' 2>/dev/null; printf '\\033[?2004l'\n");

    this.readyPromise = this._handshake();
    return this.readyPromise;
  }

  _handshake() {
    const n = 'R' + randomBytes(5).toString('hex');
    const timeoutMs = this.opts.openTimeoutMs ?? DEFAULT_OPEN_MS;
    return new Promise((resolve, reject) => {
      this.pending = {
        nonce: n, resolve, reject,
        sawEnd: false, sawErrEof: true,  // handshake has no stderr barrier
        code: 0, stdout: '', stderr: '', onStdout: null, onStderr: null,
        // NOT a job. `busy` belongs to run(), which claims it before awaiting
        // open() and holds it until its own command settles. Letting the
        // handshake clear it released the channel back to the pool mid-open:
        // the pool then dispatched a second job into the same channel, which
        // clobbered `pending`, orphaned the first command's promise (it never
        // settled) and left its watchdog to fire against nothing.
        isJob: false,
        timer: setTimeout(() => this._destroy(`channel open exceeded ${timeoutMs}ms`), timeoutMs),
      };
      this._write(`printf '\\n${n}_END_%d\\n' 0\n`);
    });
  }

  _write(s) {
    try { this.proc.stdin.write(s); } catch { this._destroy('stdin closed'); }
  }

  _ingest(chunk) {
    this.buf += stripAnsi(chunk).replace(/\r/g, '');
    const p = this.pending;
    if (!p) { if (this.buf.length > 1 << 20) this.buf = ''; return; }

    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      const endM = line.match(new RegExp(`${p.nonce}_END_(\\d+)`));
      if (endM) { p.code = Number(endM[1]); p.sawEnd = true; continue; }
      if (line.startsWith(`${p.nonce}_E `)) {
        const body = line.slice(p.nonce.length + 3);
        if (body.includes(`${p.nonce}_ERREOF`)) { p.sawErrEof = true; continue; }
        p.stderr += body + '\n';
        if (p.onStderr) p.onStderr(body);
        continue;
      }
      p.stdout += line + '\n';
      if (p.onStdout) p.onStdout(line);
    }
    if (p.sawEnd && p.sawErrEof) this._settle();
  }

  _settle() {
    const p = this.pending;
    this.pending = null;
    // Only a JOB releases the channel. See the isJob note in _handshake().
    if (p.isJob) this.busy = false;
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ code: p.code, stdout: p.stdout || '', stderr: p.stderr || '' });
  }

  _destroy(why) {
    if (this.dead) return;
    this.dead = true;
    const p = this.pending;
    this.pending = null;
    this.busy = false;
    if (p) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(why)); }
    try { this.proc && this.proc.kill('SIGKILL'); } catch { /* gone */ }
    this.proc = null;
  }

  // Run one command. Rejects if the channel dies or the command overruns; the
  // pool treats either as "replace this channel" rather than retrying blind.
  // `busy` is claimed SYNCHRONOUSLY, before the first await. Claiming it after
  // `await this.open()` left a window where two callers could pass the check on
  // the same channel and the second would clobber `pending`.
  async run(command, opts = {}) {
    if (this.dead) throw new Error('channel is dead');
    if (this.busy) throw new Error('channel is busy');
    this.busy = true;
    try {
      await this.open();
    } catch (e) {
      this.busy = false;
      throw e;
    }
    if (this.dead) { this.busy = false; throw new Error('channel is dead'); }
    const n = 'C' + randomBytes(6).toString('hex');
    const timeoutMs = opts.hardTimeoutMs ?? this.opts.hardTimeoutMs ?? DEFAULT_CMD_MS;
    return new Promise((resolve, reject) => {
      this.pending = {
        nonce: n, resolve, reject,
        sawEnd: false, sawErrEof: false,
        code: 0, stdout: '', stderr: '', isJob: true,
        onStdout: opts.onStdout || null, onStderr: opts.onStderr || null,
        // A hung command poisons its channel: there is no way to interrupt the
        // remote shell from here. Kill the channel so the pool replaces it.
        timer: timeoutMs > 0
          ? setTimeout(() => this._destroy(`command exceeded ${timeoutMs}ms; channel replaced`), timeoutMs)
          : null,
      };
      this._write(frameCommand(n, command) + '\n');
    });
  }

  close() {
    if (this.dead) return;
    try { this.proc.stdin.write('exit\n'); } catch { /* gone */ }
    this._destroy('closed by caller');
  }
}

// A small pool. Serialising every verb onto ONE channel gives back most of the
// win (measured 2.3x vs the discrete path); three channels measured 6.7x.
export class SshChannelPool {
  constructor(host, { size = 3, ...opts } = {}) {
    this.host = host;
    this.size = size;
    this.opts = opts;
    this.channels = [];
    this.queue = [];
  }

  _spare() {
    let ch = this.channels.find((c) => !c.busy && !c.dead);
    if (ch) return ch;
    this.channels = this.channels.filter((c) => !c.dead);
    if (this.channels.length < this.size) {
      ch = new SshChannel(this.host, this.opts);
      this.channels.push(ch);
      return ch;
    }
    return null;
  }

  // Jobs are DATA, drained by a pump, rather than closures re-queuing themselves.
  //
  // The first version queued an `attempt` closure and popped exactly one per
  // completion. Any attempt that woke to find no spare channel re-queued itself,
  // consuming that wakeup without dispatching anything, so the pool could come to
  // rest with an empty queue, idle channels and a caller still waiting. Observed
  // directly: 9 concurrent commands, 8 resolved, 1 never settled, queue 0, busy 0.
  //
  // A pump that loops while (spare && queued) cannot lose a wakeup: every exit
  // path either dispatched or has nothing to dispatch.
  run(command, opts = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, opts, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.queue.length) {
      const ch = this._spare();
      if (!ch) return;
      const job = this.queue.shift();
      // run() claims `busy` synchronously on entry, so no await separates the
      // _spare() check from the claim and the next loop turn sees it taken.
      ch.run(job.command, job.opts).then(
        (r) => { job.resolve(r); this._pump(); },
        (e) => { job.reject(e); this._pump(); },
      );
    }
  }

  closeAll() {
    for (const c of this.channels) { try { c.close(); } catch { /* gone */ } }
    this.channels = [];
  }
}

// Keyed by host AND the resolved ssh args, because the same host name under a
// different config (tests point HOME at a fixture) is a different destination.
const pools = new Map();
export function poolFor(host, opts = {}) {
  const key = `${host} ${(opts.sshArgs || []).join(' ')} ${opts.sshExe || ''}`;
  let p = pools.get(key);
  if (!p) { p = new SshChannelPool(host, opts); pools.set(key, p); }
  return p;
}
export function closeAllPools() {
  for (const p of pools.values()) p.closeAll();
  pools.clear();
}
