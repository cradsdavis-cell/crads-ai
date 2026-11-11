// host-docker.mjs: clear the old software versions a server keeps after each
// update, from the app, with the member's own SSH key (trap 83, 2026-11-11).
//
// WHY THE APP AND NOT THE SERVER. Every update pulls a new image and the old one
// stays on disk, untagged (~3 GB each). Servers built since 2026-11-06 clear them
// on every start; older ones never do, and the container cannot (no Docker
// socket, non-root). The only other road was root in the Hetzner web console,
// which members found miserable. But the `member` account the app signs in as is
// in the `docker` group, and sshd's ForceCommand (enter-aios) governs commands,
// not channel forwarding: `ssh -W /var/run/docker.sock` reaches the host's
// Docker API directly. So the app talks to Docker itself, for one narrow job.
//
// WHAT IT WILL DELETE, and nothing else:
//   * dangling images (no tag) that no container uses, AND
//   * whose config carries AIOS_IMAGE_TAG=, which every Crads build has baked in
//     since 2026-08-23 (Dockerfile.member / Dockerfile.rock). On a server the
//     member also uses for their own things (an adopted box), their images are
//     never candidates.
//   * each one by id, never forced: Docker itself refuses an image a container
//     still uses.
// It never needs the assistant to be running, which matters: a full disk is
// exactly when the container is likely to be down.
//
// TRANSPORT. `ssh -W <socket>` carries one HTTP/1.0 exchange over ssh's own
// stdin/stdout: no listening port anywhere. An ssh client too old to forward
// stdio to a unix socket (early Windows 10 builds) says "Bad stdio forwarding";
// only then does it fall back to `-L 127.0.0.1:<port>:<socket>` for the session,
// closed as soon as the cleanup ends.
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import http from 'node:http';
import { sshBaseArgs, sshConfigPath } from './ssh-bridge.mjs';

export const DOCKER_SOCKET = '/var/run/docker.sock';
const CRADS_ENV = 'AIOS_IMAGE_TAG=';
const DANGLING = encodeURIComponent(JSON.stringify({ dangling: ['true'] }));

// ---------------------------------------------------------------- HTTP/1.0
// Docker answers an HTTP/1.0 request with a plain body and closes; chunked is
// decoded anyway in case a proxy or a future daemon sends it.
export function parseHttpResponse(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0 || !/^HTTP\/1\.[01] \d{3}/.test(raw.subarray(0, 12).toString('latin1'))) return null;
  const head = raw.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = {};
  for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  let body = raw.subarray(end + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    const out = []; let p = 0;
    for (;;) {
      const nl = body.indexOf('\r\n', p); if (nl < 0) break;
      const n = parseInt(body.subarray(p, nl).toString('latin1'), 16);
      if (!n) break;
      out.push(body.subarray(nl + 2, nl + 2 + n)); p = nl + 2 + n + 2;
    }
    body = Buffer.concat(out);
  }
  const text = body.toString('utf8');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status, headers, text, json };
}

const requestText = (method, path) => `${method} ${path} HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n`;

// One exchange over `ssh -W`. Resolves { res } or { error, stderr, code }.
// stdin stays open until the daemon has answered: a half-close before then lets
// Go's HTTP server cancel the request mid-delete.
export function stdioExchange(host, method, path, opts = {}) {
  const cfg = opts.configPath || sshConfigPath();
  const args = [...sshBaseArgs(cfg), '-W', opts.socket || DOCKER_SOCKET, host];
  return new Promise((resolve) => {
    let child;
    try { child = (opts.spawnImpl || spawn)(opts.sshExe || 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { resolve({ error: String(e.message || e), stderr: '', code: -1 }); return; }
    const out = []; let err = ''; let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish({ error: 'timed out', stderr: err, code: -1 }), opts.timeoutMs || 60000);
    child.stdout.on('data', (d) => {
      out.push(d);
      const res = parseHttpResponse(Buffer.concat(out));
      const len = res && Number(res.headers['content-length']);
      if (res && Number.isFinite(len) && Buffer.byteLength(res.text) >= len) finish({ res });
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ error: String(e.message || e), stderr: err, code: -1 }));
    child.on('close', (code) => {
      const res = parseHttpResponse(Buffer.concat(out));
      finish(res ? { res } : { error: 'no answer from Docker', stderr: err, code });
    });
    try { child.stdin.write(requestText(method, path)); } catch { /* close handler reports it */ }
  });
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const canConnect = (port) => new Promise((resolve) => {
  const c = connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false));
});

// The fallback: one `ssh -N -L` for the whole session, private to 127.0.0.1.
async function openTcpForward(host, opts) {
  const cfg = opts.configPath || sshConfigPath();
  const port = await freePort();
  // A forward added to a shared ControlMaster would outlive this session; own connection instead.
  // FIRST, because ssh keeps the first value it is given for an option and the
  // base args turn connection sharing on.
  const args = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes', ...sshBaseArgs(cfg),
    '-N', '-L', `127.0.0.1:${port}:${opts.socket || DOCKER_SOCKET}`, host];
  const child = (opts.spawnImpl || spawn)(opts.sshExe || 'ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = ''; let exited = false;
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', () => { exited = true; });
  child.on('error', () => { exited = true; });
  for (let i = 0; i < 40 && !exited; i++) {
    if (await canConnect(port)) {
      const request = (method, path) => new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: 'docker' }, timeout: opts.timeoutMs || 60000 }, (res) => {
          let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
          res.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ } resolve({ res: { status: res.statusCode, headers: res.headers, text, json } }); });
        });
        r.on('error', (e) => resolve({ error: String(e.message || e), stderr: err }));
        r.on('timeout', () => r.destroy(new Error('timed out')));
        r.end();
      });
      return { request, close: () => { try { child.kill(); } catch { /* gone */ } } };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try { child.kill(); } catch { /* gone */ }
  return { error: 'could not open the connection to Docker', stderr: err };
}

// Why ssh could not get through, in words a member can act on.
export function transportReason(r) {
  const s = `${r.error || ''}\n${r.stderr || ''}`;
  if (/stdio forwarding (request )?failed|open refused by peer|administratively prohibited|forwarding disabled|open failed/i.test(s)) return 'refused';
  if (/Permission denied|publickey/i.test(s)) return 'not-let-in';
  if (/permission denied.*docker\.sock|connect: permission denied/i.test(s)) return 'refused';
  return 'unreachable';
}

// A session: request(method, path) -> { res } | { error, stderr }. Prefers -W.
export async function openHostDocker(host, opts = {}) {
  const viaStdio = (method, path) => stdioExchange(host, method, path, opts);
  const probe = await viaStdio('GET', '/_ping');
  if (probe.res) return { request: viaStdio, close: () => {}, mode: 'stdio' };
  if (/Bad stdio forwarding/i.test(probe.stderr || '')) {
    const t = await openTcpForward(host, opts);
    if (t.request) return { ...t, mode: 'tcp' };
    return { error: transportReason(t), detail: (t.stderr || t.error || '').trim().slice(-300) };
  }
  return { error: transportReason(probe), detail: (probe.stderr || probe.error || '').trim().slice(-300) };
}

// ---------------------------------------------------------------- the cleanup
// Pure over `request`, so it is tested without ssh or Docker.
export async function clearOldVersions(request) {
  const list = await request('GET', `/images/json?filters=${DANGLING}`);
  if (!list.res || list.res.status !== 200 || !Array.isArray(list.res.json)) {
    return { ok: false, error: 'unreachable', detail: (list.error || list.res?.text || '').slice(0, 300) };
  }
  let removed = 0; let freedBytes = 0; let kept = 0;
  for (const img of list.res.json) {
    if (!img || typeof img.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(img.Id)) continue;
    if ((img.RepoTags || []).some((t) => t && t !== '<none>:<none>')) continue;   // tagged: in service
    if (Number(img.Containers) > 0) { kept += 1; continue; }                     // a container uses it
    const info = await request('GET', `/images/${img.Id}/json`);
    const env = info.res?.json?.Config?.Env;
    if (!Array.isArray(env) || !env.some((e) => String(e).startsWith(CRADS_ENV))) continue;  // not ours
    const del = await request('DELETE', `/images/${img.Id}`);                   // never force
    if (del.res && del.res.status === 200) { removed += 1; freedBytes += Number(img.Size) || 0; }
    else kept += 1;
  }
  return { ok: true, removed, freedBytes, kept };
}

// The whole job for one server: open, clear, close. Never throws.
export async function cleanupHost(host, opts = {}) {
  let s;
  try { s = await openHostDocker(host, opts); }
  catch (e) { return { ok: false, error: 'unreachable', detail: String(e.message || e).slice(0, 300) }; }
  if (s.error) return { ok: false, error: s.error, detail: s.detail };
  try { return await clearOldVersions(s.request); }
  catch (e) { return { ok: false, error: 'unreachable', detail: String(e.message || e).slice(0, 300) }; }
  finally { s.close(); }
}
