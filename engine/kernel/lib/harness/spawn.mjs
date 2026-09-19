// spawn.mjs: the one headless process contract every harness shares.
//
// stdin CLOSED (a headless turn must never wait on a prompt) and a HARD timeout
// (a hung turn must not block the kernel forever). Until 2026-09-17 this lived
// twice, hand-copied between runner.mjs and org-publish.mjs with a comment asking
// the next person to "keep both tiny and in sync". Copies drift. This does not.
import { spawn } from 'node:child_process';

export function runBin(bin, args, { cwd, env, timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); if (code === 0) return resolve(out);
      // stdout rides along: a harness that reports failure as a JSON event on stdout
      // (opencode does, with an empty stderr) would otherwise surface as "exited 1".
      const e = new Error((err || `${bin} exited ${code}`).slice(0, 300)); e.stdout = out; reject(e); });
  });
}
