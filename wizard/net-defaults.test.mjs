// net-defaults.test.mjs: pins trap 65, node's 250 ms happy-eyeballs window.
//
// The failure needs a first-family handshake slower than the attempt window
// and a second family that fails fast. Both are reproduced on loopback: a
// lookup hands back 127.0.0.1 (listening) then ::1 (nothing there), and the
// event loop is held for 400 ms right after the first attempt starts, so the
// attempt timer is overdue by the time the loop could see the connect. That
// is the operator box's api.hetzner.cloud failure in miniature, with no
// network and no provider. Each case runs in a child so the global default
// it changes never leaks into this process.
// Run: node --test wizard/net-defaults.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MIN_ATTEMPT_TIMEOUT_MS } from './net-defaults.mjs';

const mod = (rel) => JSON.stringify(pathToFileURL(new URL(rel, import.meta.url).pathname).href);

function child(src, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, '--input-type=module', '-e', src], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(r.status, 0, `child failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// Connect to a host whose first address answers in ~400 ms and whose second
// address refuses at once. Prints {ok, code, errors}.
const SLOW_FIRST_FAMILY = `
import net from 'node:net';
const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1', () => {
  const { port } = srv.address();
  const lookup = (h, o, cb) => setImmediate(() => cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]));
  const sock = net.connect({ host: 'far.example', port, lookup, autoSelectFamily: true });
  let first = true;
  sock.on('connectionAttempt', () => {
    if (!first) return;
    first = false;
    process.nextTick(() => { const until = Date.now() + 400; while (Date.now() < until); });
  });
  const done = (r) => { console.log(JSON.stringify(r)); sock.destroy(); srv.close(); };
  sock.on('connect', () => done({ ok: true }));
  sock.on('error', (e) => done({ ok: false, code: e.code, errors: (e.errors || []).map((x) => x.code) }));
});`;

test('the trap is real: node\'s default window abandons a slow first family (ETIMEDOUT)', () => {
  const r = child(SLOW_FIRST_FAMILY);
  assert.equal(r.ok, false, 'node no longer abandons a 400 ms attempt; re-check whether trap 65 still applies');
  assert.equal(r.code, 'ETIMEDOUT');
  assert.equal(r.errors[0], 'ETIMEDOUT');
});

test('applyNetDefaults: the same slow first family now connects', () => {
  const r = child(`import { applyNetDefaults } from ${mod('./net-defaults.mjs')}; applyNetDefaults();\n${SLOW_FIRST_FAMILY}`);
  assert.deepEqual(r, { ok: true });
});

test('applyNetDefaults raises the window but never lowers a larger one from NODE_OPTIONS', () => {
  const probe = `import net from 'node:net'; import { applyNetDefaults } from ${mod('./net-defaults.mjs')};
const before = net.getDefaultAutoSelectFamilyAttemptTimeout(); const ret = applyNetDefaults(); applyNetDefaults();
console.log(JSON.stringify({ before, ret, after: net.getDefaultAutoSelectFamilyAttemptTimeout() }));`;
  const plain = child(probe);
  assert.ok(plain.before < MIN_ATTEMPT_TIMEOUT_MS, `node's default is already ${plain.before} ms`);
  assert.equal(plain.after, MIN_ATTEMPT_TIMEOUT_MS);
  assert.equal(plain.ret, MIN_ATTEMPT_TIMEOUT_MS);
  const wide = child(probe, ['--network-family-autoselection-attempt-timeout=6000']);
  assert.equal(wide.after, 6000);
});

test('the provider clients widen the window themselves, whatever process builds them', () => {
  for (const [file, cls] of [['./provision/hetzner.mjs', 'HetznerClient'], ['./provision/digitalocean.mjs', 'DigitalOceanClient']]) {
    const r = child(`import net from 'node:net'; import { ${cls} } from ${mod(file)};
new ${cls}('token', { fetchImpl: async () => { throw new Error('no network in tests'); } });
console.log(JSON.stringify({ after: net.getDefaultAutoSelectFamilyAttemptTimeout() }));`);
    assert.equal(r.after, MIN_ATTEMPT_TIMEOUT_MS, `${cls} did not apply the net defaults`);
  }
});
