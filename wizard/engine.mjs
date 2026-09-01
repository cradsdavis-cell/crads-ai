#!/usr/bin/env node
// engine.mjs: the Practice Partner provisioning engine, ported from bash to one
// zero-dependency ES module (Node 20+: node:crypto, node:fs, node:path, node:https,
// global fetch). This is the packageable core for the downloadable Windows app: it
// runs entirely on the operator's machine and talks only to the operator's own
// providers (Hetzner, Cloudflare, GitHub). BYO credentials, D33/D34 unchanged.
//
// Ports, with behavioural parity (see wizard/engine-parity.md for the step map):
//   wizard/aios-setup.sh                      -> runWizard(answers, emit)
//   provisioning/rock/provision-rock.sh   -> (called inside runWizard; also
//                                                exported as provisionRock)
//   provisioning/rock/deprovision-rock.sh -> deprovision(stateObj|path, emit)
//   provisioning/managed/lib.sh               -> inlined helpers (cf_resolve_ids,
//                                                url_status, candidates list)
//
// Parity contract: identical deployment.yaml bytes, identical cloud-init render
// (byte-comparable given the same inputs), same state-file keys and format, same
// rollback ordering, same error messages in spirit (loud, specific, HTTP codes).
//
// INTENTIONAL DIVERGENCES from the bash pair (everything else is a straight port):
//  1. Brain-repo seeding uses the GitHub Git Data API (blobs -> tree -> commit ->
//     refs/heads/main) copied from a `TEMPLATE_REPO` answer (owner/repo), instead of
//     bash's local-template-dir + `git push` (AIOS_TEMPLATE_DIR). Windows has no
//     git/ssh dependency this way. Submodule entries in the template are skipped
//     with a warning (the API cannot copy them). After the ref is created the repo's
//     default_branch is PATCHed to main (bash got this implicitly via first push).
//  2. Repo creation targets /orgs/<owner>/repos when the brain-repo owner is not the
//     token's user (bash always POSTed /user/repos, which silently creates under the
//     wrong owner for org-owned names).
//  3. The ed25519 deploy keypair is minted in-process (node:crypto) and never touches
//     disk; the OpenSSH private-key container (openssh-key-v1) is encoded here. Bash
//     shelled out to ssh-keygen and used temp files.
//  4. deployment.yaml and the rendered cloud-init exist only in memory (bash wrote
//     both to temp files and deleted them). The bytes are identical; nothing else
//     ever read those files.
//  5. Rollback guards every resource id. The bash trap referenced $TUNNEL_ID unguarded
//     under `set -u`, which could abort the trap mid-rollback (skipping deploy-key
//     revocation) when the failure happened before tunnel creation.
//  6. No TTY prompts. Fields with a documented default (PERSONA, REGION,
//     FEAT_TELEGRAM, FEAT_VOICE, OUTBOUND) fall back to that default when missing;
//     bash's strict non-interactive mode died even on defaulted fields. Fields with
//     no default still die with the same message. deprovision() has no typed-slug
//     prompt: it requires opts.confirm === slug or AIOS_CONFIRM_DESTROY=<slug>.
//  7. url_status's DoH fallback dials the resolved edge IP via node:https with SNI
//     (curl used --resolve). Same semantics: 000 on failure, then retry via 1.1.1.1.
//  8. deprovision inspects API results to decide "deleted" vs "already gone"; bash
//     only checked transport success (curl -sS exits 0 on HTTP 4xx, so bash printed
//     "deleted" even when the API said no).
//  9. No .env.local auto-load and no ANSI colour: tokens come from `answers` (with
//     process.env.AIOS_SETUP_* / provider-env fallbacks), progress goes to emit(line)
//     as plain text (the UI stripped ANSI anyway).
//
// Environment/answers accepted by runWizard (keys may be bare or AIOS_SETUP_-prefixed,
// any case): ORG_NAME ORG_DISPLAY_NAME OPERATORS DOMAIN REGION FEAT_TELEGRAM FEAT_VOICE OUTBOUND
// HCLOUD_TOKEN CF_API_TOKEN GITHUB_TOKEN BRAIN_REPO CONTENT_REPO EXTRA_YAML SLUG IMAGE
// TEMPLATE_REPO (new, divergence 1) OPERATOR_SSH_KEY_NAME GHCR_PULL_TOKEN STATE_DIR
// SERVER_TYPE LOCATION CANDIDATES CLOUD_INIT_TEMPLATE, plus the D42 vocabulary +
// permissions set (all defaulted per D42 when absent): VOCAB_AREAS_LABEL VOCAB_AREAS
// VOCAB_EXPERTS_LABEL VOCAB_TIERS PULSE_ENABLED HEARTBEATS DROPS_DIRECT AI_DISCLOSURE
// ACCESS_SSH ACCESS_BROWSER ROLE_ADMINS ROLE_SUPPORT LIFECYCLE_CONTENT LIFECYCLE_IMAGES
// LEAVER_DAYS.
//
// D42 ADDITION (js engine only; the bash pair has no equivalent): runWizard composes
// org-policy.yaml from the answers, renders the rock CLAUDE.md + notes/vocabulary.md
// from the template repo's templates/CLAUDE.md.tpl, and OVERLAYS those three files on
// top of the template tree in the seed commit. The parse/validate/render block below
// is kept in lockstep with brain-template/tools/render-identity.mjs (byte-identical
// output for the same policy + tpl is the contract). REGION keeps its documented hel1
// default here for bash parity; the wizard UI is what enforces the explicit choice.

import { setDefaultResultOrder } from 'node:dns';
// Prefer IPv4: the cloud APIs are universally v4-reachable, and environments with
// broken IPv6 egress (some VPSes, some home routers) make undici's default v6-first
// resolution hang where curl silently falls back. Harmless where v6 works.
try { setDefaultResultOrder('ipv4first'); } catch { /* older node */ }
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
// Node's Happy-Eyeballs default aborts each connect attempt after 250ms; a high-RTT
// operator (e.g. Australia to an EU API, ~300ms) loses the race on EVERY attempt and
// fetch dies ETIMEDOUT while curl works. 2s covers any realistic RTT.
try { setDefaultAutoSelectFamilyAttemptTimeout(2000); } catch { /* older node */ }
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const CF_API = 'https://api.cloudflare.com/client/v4';
const HC_API = 'https://api.hetzner.cloud/v1';
const GH_API = 'https://api.github.com';
const DEFAULT_IMAGE = 'ghcr.io/cradsdavis-cell/crads-rock:v2';
// capacity-fallback list, same order as lib.sh (cheap reliable x86 first, then ARM)
const DEFAULT_CANDIDATES = 'cx33:nbg1 cx33:hel1 cx33:fsn1 cpx32:nbg1 cpx32:hel1 cax21:nbg1 cax21:fsn1 cax21:hel1';
const DEFAULT_TEMPLATE_PATH = join(REPO, 'provisioning', 'rock', 'cloud-init.rock.template.yaml');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- emit context
function makeCtx(emit) {
  const say = (s = '') => emit(s);
  return {
    say,
    b: (s) => say(s),                 // bash b(): bold banner
    mut: (s) => say(`  ${s}`),        // bash mut(): dim note
    okw: (s) => say(`  + ${s}`),      // wizard ok()
    step: (s) => say(`▸ ${s}`),       // lib.sh step()
    ok: (s) => say(`  ✓ ${s}`),       // lib.sh ok()
    die: (msg) => { say(`ERROR: ${msg}`); const e = new Error(msg); e.engine = true; throw e; },
  };
}

// ---------------------------------------------------------------- HTTP helpers
async function http(method, url, { token, body, headers = {}, timeoutMs = 60000 } = {}) {
  const opts = { method, redirect: 'follow', headers: { 'user-agent': 'aios-setup-engine', ...headers } };
  if (token) opts.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  opts.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* non-JSON body */ } }
  return { status: res.status, ok: res.ok, json, text };
}

const gh = (token, method, path, body, timeoutMs) =>
  http(method, path.startsWith('http') ? path : GH_API + path,
    { token, body, headers: { accept: 'application/vnd.github+json' }, timeoutMs });

// cf_call parity: every Cloudflare call checks success:true, dies loud with context.
async function cfCall(ctx, token, context, method, url, body) {
  let r;
  try { r = await http(method, url, { token, body }); }
  catch { ctx.die(`Cloudflare ${context}: request failed (network)`); }
  if (!r.json || r.json.success !== true) {
    ctx.die(`Cloudflare ${context} failed: ${JSON.stringify(r.json ? (r.json.errors ?? r.json) : r.text)}`);
  }
  return r.json.result;
}

// hc() parity: curl -fsS dies on HTTP error, so a failed poll aborts (and rolls back).
async function hcGet(ctx, token, url) {
  let r;
  try { r = await http('GET', url, { token }); }
  catch { ctx.die('Hetzner API request failed (network)'); }
  if (!r.ok) ctx.die(`Hetzner API error (HTTP ${r.status}): ${String(r.text).slice(0, 300)}`);
  return r.json;
}

// hc_wait_running() parity (lib.sh). Poll a freshly created VM until Hetzner
// says it is running with an IPv4. Not hcGet in a loop, for the reason the
// shell twin was rewritten on 2026-08-10: hcGet dies on ANY non-2xx, so one 429
// or one 404 killed the stamp on the first poll and the retry was decorative.
// A rock build died that way when its VM was deleted underneath it seconds
// after creation, and the operator saw an opaque `HTTP 404`. Three behaviours:
// a transient error is retried; a repeating 404 is reported as DELETED rather
// than slow; and running out of attempts fails, where the old loop fell through
// to `running at null` and wrote SERVER_IP: "null" into the state file.
//
// The 404 rule needs a prior 200 (2026-08-12, shell twin has the long version).
// "Three 404s in six seconds means someone deleted it" killed a healthy pebble
// build, and the caller's rollback then deleted the VM, so the verdict proved
// itself. A never-yet-seen server rides the whole wait instead; only a server
// that answered and then stopped answering is called GONE. On the unproven path
// ctx.keepServer is set so the caller does NOT roll the VM back.
export async function hcWaitRunning(ctx, token, serverId, { tries = 60, gapMs = 3000 } = {}) {
  let soft = 0, gone = 0, notfound = 0, seen = false, status = 'unknown';
  for (let i = 0; i < tries; i++) {
    let r = null;
    try { r = await http('GET', `${HC_API}/servers/${serverId}`, { token, timeoutMs: 20000 }); }
    catch { r = null; }
    if (r?.ok) {
      soft = 0; gone = 0; seen = true;
      status = String(r.json?.server?.status ?? 'unknown');
      const ip = String(r.json?.server?.public_net?.ipv4?.ip ?? '');
      if (status === 'running' && ip && ip !== 'null') return ip;
    } else if (r?.status === 404) {
      notfound++;
      if (seen && ++gone >= 3) {
        ctx.die(`server ${serverId} is GONE: Hetzner returned it and then answered 404 for it ${gone} polls running. `
          + 'It existed, so this is not a slow boot: something deleted it underneath this '
          + 'build (a concurrent teardown, a console delete, or the whole project being emptied). '
          + 'Check the project before re-running.');
      }
    } else if (r?.status === 401 || r?.status === 403) {
      ctx.die(`Hetzner refused the token while waiting on server ${serverId} (HTTP ${r.status}).`);
    } else if (++soft >= 10) {
      ctx.die(`Hetzner unreachable while waiting on server ${serverId}: ${soft} consecutive failures, `
        + `last HTTP ${r?.status ?? 'network'}.`);
    }
    await sleep(gapMs);
  }
  if (!seen && notfound > 0) {
    ctx.keepServer = true;   // unproven: the caller must NOT roll this VM back
    ctx.die(`server ${serverId} never became visible: Hetzner answered 404 on ${notfound} of ${tries} polls `
      + `across ${Math.round((tries * gapMs) / 1000)}s and never once returned it. This is NOT proof that `
      + 'anything deleted it: a just-created server can read back 404, and a create whose asynchronous '
      + 'action failed is reaped by Hetzner itself. The VM has been left in place so it can still be '
      + 'inspected; delete it by hand if it is real and unwanted.');
  }
  ctx.die(`server ${serverId} never reached 'running' with an IPv4 in ${Math.round((tries * gapMs) / 1000)}s `
    + `(last status: ${status}).`);
}

// url_status parity (lib.sh): plain probe first (8s), then DoH-resolve an edge IPv4
// via 1.1.1.1 and retry against the IP with SNI (10s). Returns a curl-style code string.
async function urlStatus(url) {
  const host = url.replace(/^https?:\/\/([^/]+).*$/, '$1');
  let code = '000';
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'aios-setup-engine' } });
    code = String(r.status);
  } catch { code = '000'; }
  if (code === '000') {
    try {
      const doh = await fetch(`https://1.1.1.1/dns-query?name=${host}&type=A`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
      const j = await doh.json();
      const ip = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data)[0];
      if (ip) code = await httpsStatusViaIp(url, host, ip);
    } catch { /* stay 000 */ }
  }
  return code;
}

// wait_for_box() parity (lib.sh). Wait for a freshly stamped box to be REACHABLE,
// and claim only what that proves.
//
// This path polled for 200/302 until 2026-08-10, which is the pre-door-shut check.
// The 2026-08-05 ruling routes the public hostname at http_status:404, so 200/302
// became unreachable by construction: a perfectly healthy rock burned all 90 polls
// (12 minutes) and was then reported as "not serving yet". lib.sh fixed this on
// 2026-08-09 and its comment names the three consumers found stale at the time.
// This was the fourth, and the only one that still asked the shut door a question
// it can no longer answer.
//
// What an answer means now: ANY HTTP status that is not 000/52x/530 proves
// cloudflared is connected and Cloudflare is routing, so the VM booted and the
// tunnel came up. 404 is the CORRECT healthy answer. It does NOT prove the
// container is up, which is why the caller says "reachable" and not "live".
// Returns 'reachable' | 'timeout'.
export async function waitForBox(ctx, host, { tries = 90, gapMs = 8000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const code = await urlStatus(`https://${host}/`);
    if (!/^(000|52\d|530)$/.test(code)) return 'reachable';
    if (i % 5 === 0) ctx.say(`  …still booting (${code}), ${Math.floor((i * gapMs) / 60000)}m elapsed`);
    await sleep(gapMs);
  }
  return 'timeout';
}

function httpsStatusViaIp(url, host, ip) {
  return new Promise((resolveP) => {
    let u;
    try { u = new URL(url); } catch { return resolveP('000'); }
    const req = https.request({
      host: ip, servername: host, port: 443,
      path: (u.pathname || '/') + (u.search || ''), method: 'GET',
      headers: { host, 'user-agent': 'aios-setup-engine' }, timeout: 10000,
    }, (res) => { res.resume(); resolveP(String(res.statusCode)); });
    req.on('timeout', () => { req.destroy(); resolveP('000'); });
    req.on('error', () => resolveP('000'));
    req.end();
  });
}

// ---------------------------------------------------------------- pure helpers
// slug rules, verbatim from the bash pair
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;            // aios-setup.sh
const VALID_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;       // lib.sh valid_slug

// "owner/name" out of git@github.com:o/r.git or https://github.com/o/r(.git)
export function repoPathOf(url) {
  return String(url).replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

// dget parity: grep -oP "^key:\s*\"?\K[^\"#]*" | head -1 | sed 's/[[:space:]]*$//'
function dget(content, key) {
  for (const line of String(content).split('\n')) {
    const m = line.match(new RegExp(`^${key}:\\s*"?([^"#]*)`));
    if (m) return m[1].replace(/\s+$/, '');
  }
  return '';
}

// The operator_emails block, byte-matching the wizard's
//   printf '%s' "$OPERATORS" | tr ',' '\n' | sed 's/^[[:space:]]*/  - /'
// inside $(...): a trailing comma yields no extra line (no trailing newline into sed);
// interior/leading empty segments DO yield "  - " lines; empty input yields nothing.
function operatorsBlock(operators) {
  const s = String(operators);
  if (s === '') return '';
  const segs = s.split(',');
  if (segs.length > 1 && segs[segs.length - 1] === '') segs.pop();
  return segs.map((x) => '  - ' + x.replace(/^[\t\v\f\r ]*/, '')).join('\n');
}

// Byte-identical to the aios-setup.sh heredoc (incl. the trailing space after
// "content_repo:" when empty, and the trailing EXTRA_YAML line).
export function buildDeploymentYaml(a) {
  return `deployment_name: ${a.ORG_NAME}\n`
    + 'operator_emails:\n'
    + `${operatorsBlock(a.OPERATORS ?? '')}\n`
    + `domain: ${a.DOMAIN}\n`
    + `brain_repo: ${a.BRAIN_REPO}\n`
    + `content_repo: ${a.CONTENT_REPO ?? ''}\n`
    + 'brain_root: /state/brain\n'
    + `persona_name: ${a.PERSONA}\n`
    + `default_region: ${a.REGION}\n`
    + `features_telegram: "${a.FEAT_TELEGRAM}"\n`
    + `features_voice: "${a.FEAT_VOICE}"\n`
    + `outbound_policy: "${a.OUTBOUND}"\n`
    + `${a.EXTRA_YAML ?? ''}\n`;
}

// The staged factory env, byte-identical to the provisioner's printf | base64 -w0.
export function factoryEnvB64(v) {
  const s = `HCLOUD_TOKEN=${v.HCLOUD_TOKEN}\nCF_API_TOKEN=${v.CF_API_TOKEN}\nCF_ACCOUNT_ID=${v.CF_ACCOUNT_ID}\n`
    + `CF_TUNNEL_ROOT_DOMAIN=${v.ROOT_DOMAIN}\nCF_ZONE_NAME=${v.CF_ZONE_NAME}\nGITHUB_TOKEN=${v.GITHUB_TOKEN}\n`
    + `GH_OWNER=${v.GH_OWNER}\nOPERATOR_SSH_KEY_NAME=${v.OPERATOR_SSH_KEY_NAME ?? ''}\n`
    + `PEBBLE_IMAGE=${String(v.IMAGE ?? '').replace('ai-os-parent', 'ai-os-member').replace('crads-rock', 'crads-pebble')}\n`;
  return Buffer.from(s, 'utf8').toString('base64');
}

// Cloud-init render: a faithful port of the provisioner's inline python (replace-all
// semantics; split/join is used so '$' in values can never be treated as a pattern).
export function renderCloudInit(template, v) {
  let t = String(template);
  const key = String(v.PRIVATE_KEY).replace(/\n+$/, '');            // python rstrip('\n')
  const keyBlock = key.split('\n').map((l) => '      ' + l).join('\n');
  t = t.split('      __BRAIN_DEPLOY_KEY__').join(keyBlock);
  t = t.split('__DEPLOYMENT_YAML_B64__').join(Buffer.from(String(v.DEPLOYMENT_YAML), 'utf8').toString('base64'));
  for (const k of ['IDE_PASSWORD', 'TUNNEL_TOKEN', 'IMAGE', 'BRAIN_REPO', 'BRAIN_ROOT', 'GHCR_PULL_TOKEN', 'FACTORY_ENV_B64']) {
    t = t.split(`__${k}__`).join(String(v[k]));
  }
  t = t.split('__SSH_FIREWALL_RULE__').join(v.SSH_RULE ?? '/bin/true');
  // D40: same e.get() semantics as the provisioner's python (absent -> the disabled
  // placeholder; empty string stays empty)
  t = t.split('__OPERATOR_PUBKEY__').join(v.OPERATOR_PUBKEY ?? 'ssh-ed25519 AAAA-no-operator-key-staged disabled');
  if (t.includes('__BRAIN_DEPLOY_KEY__')) throw new Error('cloud-init render: __BRAIN_DEPLOY_KEY__ not substituted');
  return t;
}

// ------------------------------------------------- ed25519 OpenSSH key encoding
// Pure node:crypto replacement for `ssh-keygen -t ed25519 -N '' -C <comment>`.
// Public: "ssh-ed25519 <b64(blob)> <comment>\n". Private: the openssh-key-v1
// container (cipher none, kdf none, 1 key, checkint pair, seed||pub, comment,
// 1,2,3... padding to the 8-byte blocksize), base64 wrapped at 70 columns.
function sshStr(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0);
  return Buffer.concat([l, b]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

// Recover the OpenSSH public line from one of our own private keys. The public key is
// embedded in the openssh-key-v1 blob, so this is a pure structural parse (Node's
// createPrivateKey cannot read OpenSSH private keys). Used to self-heal a device key whose
// .pub went missing after an interrupted setup, instead of telling a member to move files.
// Returns null if the blob is not one of ours / not parseable (the caller mints fresh then).
export function derivePublicKey(privatePem, comment) {
  try {
    const m = String(privatePem).match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/);
    if (!m) return null;
    const blob = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (blob.subarray(0, magic.length).toString('utf8') !== magic) return null;
    let o = magic.length;
    const rd = () => { const n = blob.readUInt32BE(o); o += 4; const s = blob.subarray(o, o + n); o += n; return s; };
    rd(); rd(); rd();                       // ciphername, kdfname, kdfoptions
    if (blob.readUInt32BE(o) < 1) return null; o += 4;   // number of keys
    const pubBlob = rd();                    // sshStr(pubBlob): ssh-ed25519 type + 32-byte pub
    const tlen = pubBlob.readUInt32BE(0);
    if (pubBlob.subarray(4, 4 + tlen).toString('utf8') !== 'ssh-ed25519') return null;
    return `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}\n`;
  } catch { return null; }
}

export function generateDeployKeypair(comment) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);    // raw A
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32); // raw k
  const pubBlob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check, check,
    sshStr('ssh-ed25519'), sshStr(pub),
    sshStr(Buffer.concat([seed, pub])),
    sshStr(comment),
  ]);
  const padLen = (8 - (priv.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  priv = Buffer.concat([priv, pad]);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshStr('none'), sshStr('none'), sshStr(''),
    u32(1), sshStr(pubBlob), sshStr(priv),
  ]);
  const wrapped = blob.toString('base64').match(/.{1,70}/g).join('\n');
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}\n`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}

// ---------------------------------------------------------------- state file
const STATE_KEYS = ['SLUG', 'ROLE', 'DEPLOYMENT', 'HOSTNAME', 'SERVER_ID', 'SERVER_SPEC', 'SERVER_IP',
  'TUNNEL_ID', 'RECORD_ID', 'DEPLOY_KEY_ID', 'BRAIN_REPO', 'CF_ACCOUNT_ID', 'CF_ZONE_ID'];

export function serializeState(st) {
  return STATE_KEYS.map((k) => `${k}="${st[k] ?? ''}"`).join('\n') + '\n';
}

export function parseStateFile(text) {
  const st = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"(.*)"|(.*?))\s*$/);
    if (m) st[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return st;
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ================================================== D42 org policy + identity
// Shared-shape block. KEEP IN LOCKSTEP with brain-template/tools/render-identity.mjs:
// parseOrgPolicy / validateOrgPolicy / policySlots / renderSlots / renderVocabularyMd
// are duplicated there verbatim (modulo this comment); byte-identical rendered output
// for the same inputs is the contract. buildOrgPolicyYaml is engine-only (the tool
// reads a policy, it never composes one).

export const splitList = (s) => String(s ?? '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);

// factory#2: a tier item is a flat string "name|description" (the pipe + description
// are optional). Splits on the FIRST pipe only, so a description may itself contain
// pipes. A plain-name item (no pipe) returns an empty description.
export function parseTierItem(s) {
  const str = String(s ?? '');
  const i = str.indexOf('|');
  if (i < 0) return { name: str.trim(), description: '' };
  return { name: str.slice(0, i).trim(), description: str.slice(i + 1).trim() };
}

// factory#2: tiers arrive from the wizard as newline-separated "name|description"
// rows (a description can contain commas, so newline is the row separator). A legacy
// single-line comma-list of bare names (`standard, core`, no pipes) still splits on
// commas. Returns the raw flat item strings, ready for yamlList.
export const splitTiers = (s) => String(s ?? '').split('\n').flatMap((line) => {
  const t = line.trim();
  if (!t) return [];
  if (t.includes('|')) return [t];                 // name|description row: keep whole
  return t.split(',').map((x) => x.trim()).filter(Boolean);   // legacy bare-name list
});

const yamlList = (items, indent = '    ') =>
  (items.length ? '\n' + items.map((i) => `${indent}- ${i}`).join('\n') : ' []');

// Compose org-policy.yaml (2-level FORMAT CONTRACT; D42 defaults are the caller's
// job via the answer defaults in runWizard). Values arrive as strings/booleans.
export function buildOrgPolicyYaml(p) {
  return `# ============================================================================
# org-policy.yaml (schema v1) · composed by the setup wizard (D42)
# The rock brain's CLAUDE.md + notes/vocabulary.md are RENDERED from this file
# by tools/render-identity.mjs. Edit here, re-render, never hand-edit those.
# Format: top-level scalars + 2-level blocks + scalar lists only (flat readers).
# The invariants block is LOCKED: the renderer refuses if any key is loosened.
# ============================================================================
schema_version: 1

org:
  name: "${p.name}"
  display_name: "${p.displayName}"
  domain: "${p.domain}"
  persona: "${p.persona}"

vocabulary:
  areas_label: "${p.areasLabel}"
  areas:${yamlList(p.areas)}
  experts_label: "${p.expertsLabel}"
  experts:${yamlList(p.experts)}
  tiers:${yamlList(p.tiers)}

pulse:
  enabled: ${p.pulseEnabled}
  name: "${p.pulseName}"
  landing_page: "${p.pulseLanding}"

heartbeats: ${p.heartbeats}
region: ${p.region}

drops:
  direct_to_member: ${p.dropsDirect}

access:
  ssh: ${p.accessSsh}
  browser_fallback: ${p.accessBrowser}

roles:
  admins:${yamlList(p.admins)}
  support:${yamlList(p.support)}

lifecycle:
  content_updates: ${p.contentUpdates}
  images: ${p.images}
  leaver_timeline_days: ${p.leaverDays}
  leaver_portability: true

member_defaults:
  outbound: "${p.outbound}"
  ai_disclosure: ${p.aiDisclosure}
  challenge_before_comply: true
  quiet_hours: "${p.quietHours}"
  timezone: "${p.timezone}"

invariants:
  outbound_propose_confirm: true
  privacy_no_member_readback: true
  member_data_portability: true
`;
}

// Two-level YAML subset reader (see the FORMAT CONTRACT in org-policy.yaml):
// top-level scalars, top-level blocks of scalar keys, and lists of scalars
// (block `- item` lines or inline []). Returns a flat map: 'a' or 'a.b' ->
// string, or array-of-strings for lists.
export function parseOrgPolicy(text) {
  const pol = {};
  let section = null;
  let listKey = null;
  const clean = (s) => {
    const v = String(s).trim();
    const q = v.match(/^"([^"]*)"/) || v.match(/^'([^']*)'/);
    if (q) return q[1];
    return v.split(/\s#/)[0].trim();
  };
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    let m;
    if ((m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/))) {
      const rest = m[2].trim();
      if (rest === '' || rest.startsWith('#')) { section = m[1]; listKey = m[1]; }
      else if (rest === '[]') { pol[m[1]] = []; section = null; listKey = null; }
      else { pol[m[1]] = clean(rest); section = null; listKey = null; }
      continue;
    }
    if (section && (m = raw.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/))) {
      const key = `${section}.${m[1]}`;
      const rest = m[2].trim();
      if (rest === '' || rest.startsWith('#')) { listKey = key; pol[key] = pol[key] || []; }
      else if (rest === '[]') { pol[key] = []; listKey = null; }
      else { pol[key] = clean(rest); listKey = null; }
      continue;
    }
    if (listKey && (m = raw.match(/^\s*-\s*(.*)$/))) {
      if (!Array.isArray(pol[listKey])) pol[listKey] = [];
      pol[listKey].push(clean(m[1]));
      continue;
    }
  }
  return pol;
}

// [key, locked value, message]. String-compared so `true`/'true' both pass.
export const POLICY_LOCKED = [
  ['invariants.outbound_propose_confirm', 'true', 'outbound propose-confirm is a locked product invariant'],
  ['invariants.privacy_no_member_readback', 'true', 'the no-member-read-back privacy boundary is a locked product invariant'],
  ['invariants.member_data_portability', 'true', 'a member-owned brain is always portable, locked; org-owned work boxes stay with the org (D60)'],
  ['member_defaults.outbound', 'propose-confirm', 'member outbound policy cannot be loosened from propose-confirm'],
];

export function validateOrgPolicy(pol) {
  const errs = [];
  for (const [key, locked, why] of POLICY_LOCKED) {
    const v = pol[key];
    if (String(v ?? '') !== locked) {
      errs.push(`INVARIANT: ${key} is ${JSON.stringify(v ?? null)}, must be ${JSON.stringify(locked)} (${why})`);
    }
  }
  if (!String(pol['org.name'] ?? '').trim()) errs.push('POLICY: org.name is empty (the org must be named)');
  if (!String(pol['region'] ?? '').trim()) errs.push('POLICY: region is empty (region is explicit, e.g. hel1 or sin; no silent default)');
  if (errs.length) { const e = new Error(errs.join('\n')); e.policy = true; throw e; }
  return pol;
}

export function policySlots(pol) {
  const list = (k) => (Array.isArray(pol[k]) ? pol[k] : []);
  const onOff = (k, d) => (String(pol[k] ?? d) === 'true' ? 'ON' : 'OFF');
  const joinOr = (arr, fb) => (arr.length ? arr.join(', ') : fb);
  const name = String(pol['org.name'] ?? '');
  // factory#2: tiers are flat "name|description" strings; expose the parsed pairs
  // (TIERS) and a human list (TIERS_LIST) that shows descriptions where present.
  const tiers = list('vocabulary.tiers').map(parseTierItem);
  const tiersList = tiers.map((t) => (t.description ? `${t.name} (${t.description})` : t.name));
  return {
    ORG_NAME: name,
    ORG_DISPLAY_NAME: String(pol['org.display_name'] || name),
    // ONE NAME (2026-08-14, docs/naming.md): a rock's assistant is called what
    // the rock is called. PERSONA is a derived mirror of the display name so
    // rendered templates and older readers keep resolving; it is never asked
    // for, and it no longer defaults to the literal "Foreman", which is what
    // put a stranger's name on the Overview of every rock somebody had named.
    PERSONA: String(pol['org.display_name'] || name),
    DOMAIN: String(pol['org.domain'] || ''),
    AREAS_LABEL: String(pol['vocabulary.areas_label'] || 'Areas'),
    AREAS_LIST: joinOr(list('vocabulary.areas'), '(none named yet; add them in org-policy.yaml and re-render)'),
    EXPERTS_LABEL: String(pol['vocabulary.experts_label'] || 'Experts'),
    EXPERTS_LIST: joinOr(list('vocabulary.experts'), '(none named yet)'),
    TIERS_LIST: joinOr(tiersList, '(single tier)'),
    TIERS: tiers,
    PULSE_NAME: String(pol['pulse.name'] || 'Pulse'),
    PULSE_STATE: String(pol['pulse.enabled'] ?? 'true') === 'true'
      ? 'ON by default, opt-in per member' : 'OFF for this org',
    PULSE_LANDING: String(pol['pulse.landing_page'] || 'notes/pulse/'),
    HEARTBEATS: String(pol['heartbeats'] || 'minimal'),
    REGION: String(pol['region'] || ''),
    DROPS_DIRECT: onOff('drops.direct_to_member', 'true'),
    ACCESS_SSH: onOff('access.ssh', 'true'),
    ACCESS_BROWSER: onOff('access.browser_fallback', 'true'),
    ADMINS_LIST: joinOr(list('roles.admins'), '(none set)'),
    SUPPORT_LIST: joinOr(list('roles.support'), '(none)'),
    CONTENT_UPDATES: String(pol['lifecycle.content_updates'] || 'auto'),
    IMAGES_POLICY: String(pol['lifecycle.images'] || 'pinned'),
    LEAVER_DAYS: String(pol['lifecycle.leaver_timeline_days'] || '30'),
    OUTBOUND_POLICY: String(pol['member_defaults.outbound'] || 'propose-confirm'),
    AI_DISCLOSURE: onOff('member_defaults.ai_disclosure', 'true'),
    QUIET_HOURS: String(pol['member_defaults.quiet_hours'] || '21:00-06:30'),
    TIMEZONE: String(pol['member_defaults.timezone'] || 'Australia/Sydney'),
  };
}

export function renderSlots(tpl, slots) {
  const out = String(tpl).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
  const left = out.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) { const e = new Error(`unfilled template slots: ${[...new Set(left)].join(' ')}`); e.policy = true; throw e; }
  return out;
}

export function renderVocabularyMd(slots) {
  return `# ${slots.ORG_DISPLAY_NAME}: vocabulary map\n`
    + '\n'
    + '> Rendered from org-policy.yaml by tools/render-identity.mjs. Edit the policy and re-render; never hand-edit this page.\n'
    + '\n'
    + '| This org says | Product term | Values |\n'
    + '|---|---|---|\n'
    + `| ${slots.AREAS_LABEL} | areas | ${slots.AREAS_LIST} |\n`
    + `| ${slots.EXPERTS_LABEL} | experts | ${slots.EXPERTS_LIST} |\n`
    + `| Tiers | tiers | ${slots.TIERS_LIST} |\n`
    + `| ${slots.PULSE_NAME} | pulse | ${slots.PULSE_STATE}; rollups land at ${slots.PULSE_LANDING} |\n`
    + '\n'
    // factory#2: one row per membership level with its plain-words description, so
    // the org (and anyone reading the brain) can see what each level actually means.
    + tiersTable(slots.TIERS)
    + '- Registry rows store tier SLUGS from the tier list above.\n'
    + `- ${slots.PULSE_NAME} and heartbeats (${slots.HEARTBEATS}) are the only member-to-org flows. Everything else is push-down.\n`;
}

// factory#2: the membership-level detail table (empty string when no tiers).
function tiersTable(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return '';
  return '## Membership levels\n\n'
    + '| Tier | Description |\n|---|---|\n'
    + tiers.map((t) => `| ${t.name} | ${t.description} |`).join('\n')
    + '\n\n';
}

// policy text + template text -> both rendered artifacts (throws on tamper)
export function renderIdentity(tplText, policyText) {
  const pol = validateOrgPolicy(parseOrgPolicy(policyText));
  const slots = policySlots(pol);
  return { claudeMd: renderSlots(tplText, slots), vocabularyMd: renderVocabularyMd(slots), slots };
}

// ---------------------------------------------------------------- answers
function normalizeAnswers(answers = {}) {
  const a = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === undefined || v === null) continue;
    a[k.replace(/^AIOS_SETUP_/i, '').toUpperCase()] = String(v);
  }
  return a;
}
function pick(a, name, def) {
  const v = a[name] ?? process.env[`AIOS_SETUP_${name}`];
  if (v !== undefined && v !== '') return v;
  return def; // may be undefined
}

// ---------------------------------------------------- brain-repo seed (API path)
// Divergence 1: copy the template repo's tree into the fresh repo via the Git Data
// API. Nested paths in one create-tree call; blobs re-created base64 so binary
// content survives; modes (100644/100755/120000) preserved from the template tree.
// D42: when opts.policyText is given, the composed org-policy.yaml plus the rendered
// CLAUDE.md + notes/vocabulary.md are OVERLAID on the template tree in the seed
// commit (same-path template entries are replaced). The identity template comes from
// the template repo's own templates/CLAUDE.md.tpl.
async function seedBrainRepoFromTemplate(ctx, ghToken, repoPath, templateRepo, orgName, opts = {}) {
  const tpl = repoPathOf(templateRepo);
  const tr = await gh(ghToken, 'GET', `/repos/${tpl}`);
  if (!tr.ok) ctx.die(`cannot read template repo ${tpl} (HTTP ${tr.status}); set TEMPLATE_REPO to an owner/repo this token can read`);
  const branch = tr.json.default_branch || 'main';
  const tree = await gh(ghToken, 'GET', `/repos/${tpl}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!tree.ok) ctx.die(`cannot list template tree for ${tpl}@${branch} (HTTP ${tree.status})`);
  if (tree.json.truncated) ctx.die(`template tree for ${tpl} is truncated (too many entries for the Trees API); use a smaller template repo`);
  const all = tree.json.tree || [];
  for (const e of all.filter((x) => x.type === 'commit')) {
    ctx.mut(`! skipping submodule ${e.path} (API seeding cannot copy submodules)`);
  }
  const blobs = all.filter((e) => e.type === 'blob');
  ctx.mut(`seeding ${blobs.length} files from ${tpl}@${branch}`);

  // D42 overlays: render the org identity before uploading, so a render refusal
  // (tampered invariant, unfilled slot) aborts the seed cleanly.
  const overlays = {};
  if (opts.policyText) {
    overlays['org-policy.yaml'] = opts.policyText;
    const tplEntry = blobs.find((e) => e.path === 'templates/CLAUDE.md.tpl');
    if (tplEntry) {
      const tb = await gh(ghToken, 'GET', `/repos/${tpl}/git/blobs/${tplEntry.sha}`);
      if (!tb.ok) ctx.die(`template blob read failed for templates/CLAUDE.md.tpl (HTTP ${tb.status})`);
      const tplText = Buffer.from(tb.json.content ?? '', 'base64').toString('utf8');
      let rendered;
      try { rendered = renderIdentity(tplText, opts.policyText); }
      catch (e) { ctx.die(`org identity render refused:\n${e.message}`); }
      overlays['CLAUDE.md'] = rendered.claudeMd;
      overlays['notes/vocabulary.md'] = rendered.vocabularyMd;
      ctx.mut('rendered org identity from org-policy.yaml (CLAUDE.md + notes/vocabulary.md)');
    } else {
      // pre-D42 template: still ship the policy + vocabulary so the org is described
      let vocab;
      try { vocab = renderVocabularyMd(policySlots(validateOrgPolicy(parseOrgPolicy(opts.policyText)))); }
      catch (e) { ctx.die(`org policy invalid:\n${e.message}`); }
      overlays['notes/vocabulary.md'] = vocab;
      ctx.mut('! template has no templates/CLAUDE.md.tpl; seeding its stock CLAUDE.md (org-policy.yaml + vocabulary still overlaid)');
    }
  }

  const treeSpec = [];
  for (let i = 0; i < blobs.length; i += 8) {
    await Promise.all(blobs.slice(i, i + 8).map(async (e) => {
      const blob = await gh(ghToken, 'GET', `/repos/${tpl}/git/blobs/${e.sha}`);
      if (!blob.ok) ctx.die(`template blob read failed for ${e.path} (HTTP ${blob.status})`);
      const put = await gh(ghToken, 'POST', `/repos/${repoPath}/git/blobs`,
        { content: blob.json.content ?? '', encoding: blob.json.encoding || 'base64' });
      if (!put.ok) ctx.die(`blob create failed for ${e.path} in ${repoPath} (HTTP ${put.status}): ${String(put.text).slice(0, 200)}`);
      treeSpec.push({ path: e.path, mode: e.mode, type: 'blob', sha: put.json.sha });
    }));
  }

  for (const [p, content] of Object.entries(overlays)) {
    const put = await gh(ghToken, 'POST', `/repos/${repoPath}/git/blobs`, { content, encoding: 'utf-8' });
    if (!put.ok) ctx.die(`overlay blob create failed for ${p} in ${repoPath} (HTTP ${put.status}): ${String(put.text).slice(0, 200)}`);
    const entry = { path: p, mode: '100644', type: 'blob', sha: put.json.sha };
    const i = treeSpec.findIndex((t) => t.path === p);
    if (i >= 0) treeSpec[i] = entry; else treeSpec.push(entry);
  }
  if (opts.policyText) ctx.mut(`overlaid ${Object.keys(overlays).length} rendered file(s) on the seed`);

  const nt = await gh(ghToken, 'POST', `/repos/${repoPath}/git/trees`, { tree: treeSpec });
  if (!nt.ok) ctx.die(`tree create failed in ${repoPath} (HTTP ${nt.status}): ${String(nt.text).slice(0, 200)}`);
  const commit = await gh(ghToken, 'POST', `/repos/${repoPath}/git/commits`, {
    message: `seed: ${orgName} brain (wizard, from template)`,
    tree: nt.json.sha,
    rocks: [],
    author: { name: `${orgName} setup`, email: 'setup@local' },
  });
  if (!commit.ok) ctx.die(`seed commit failed in ${repoPath} (HTTP ${commit.status}): ${String(commit.text).slice(0, 200)}`);
  let ref = await gh(ghToken, 'POST', `/repos/${repoPath}/git/refs`, { ref: 'refs/heads/main', sha: commit.json.sha });
  if (!ref.ok) {
    // auto_init repos already have main; move it to the seed commit instead
    ref = await gh(ghToken, 'PATCH', `/repos/${repoPath}/git/refs/heads/main`, { sha: commit.json.sha, force: true });
  }
  if (!ref.ok) ctx.die(`could not set refs/heads/main in ${repoPath} (HTTP ${ref.status}): ${String(ref.text).slice(0, 200)}`);
  await gh(ghToken, 'PATCH', `/repos/${repoPath}`, { default_branch: 'main' }).catch(() => {}); // best-effort
}

// ================================================================ runWizard
// The aios-setup.sh flow: validate answers, verify tokens with read-only pings,
// auto-name/create/seed the brain repo, build deployment.yaml, then provision.
export async function runWizard(answers, emit = (l) => console.log(l)) {
  const ctx = makeCtx(emit);
  const a = normalizeAnswers(answers);
  const req = (name) => {
    const v = pick(a, name);
    if (v === undefined) {
      ctx.die(`no terminal and no $AIOS_SETUP_${name} set (non-interactive runs must provide every AIOS_SETUP_* answer)`);
    }
    return v;
  };

  ctx.b('Practice Partner: rock setup');
  ctx.say('');

  ctx.b('1/5  Your rock');
  const ORG_NAME = req('ORG_NAME');
  if (!ORG_SLUG_RE.test(ORG_NAME)) ctx.die('use a DNS-safe slug: lowercase letters/digits/hyphens');
  const OPERATORS = req('OPERATORS');
  // ONE NAME (2026-08-14, docs/naming.md). The rock is asked for its name, once.
  // ORG_NAME is the DNS-safe handle; ORG_DISPLAY_NAME is what people read, and
  // it falls back to the handle only when the caller supplies nothing. Before
  // this, buildOrgPolicyYaml was called with `displayName: ORG_NAME`, so this
  // path could not produce a display name that differed from the slug, which
  // is exactly why the defect stayed invisible on every rock Sam set up by CLI.
  const ORG_DISPLAY_NAME = pick(a, 'ORG_DISPLAY_NAME', ORG_NAME);
  const PERSONA = ORG_DISPLAY_NAME;   // derived mirror, never asked for
  const DOMAIN = req('DOMAIN');
  const REGION = pick(a, 'REGION', 'hel1');
  ctx.say('');

  ctx.b("2/5  What your members' boxes include");
  const FEAT_TELEGRAM = pick(a, 'FEAT_TELEGRAM', 'yes');
  const FEAT_VOICE = pick(a, 'FEAT_VOICE', 'no');
  const OUTBOUND = pick(a, 'OUTBOUND', 'propose-confirm');

  // D42 vocabulary + permissions -> org-policy.yaml (defaults per D42 when absent).
  // yes/no arrive from the UI toggles; bare policy words are accepted too.
  const yn = (name, def) => !['no', 'false', 'off', '0'].includes(String(pick(a, name, def)).toLowerCase());
  const mapWord = (name, def, map) => map[String(pick(a, name, def)).toLowerCase()] ?? String(pick(a, name, def));
  const ROLE_ADMINS = pick(a, 'ROLE_ADMINS', '') || OPERATORS; // operators land in roles.admins by default
  const orgPolicyYaml = buildOrgPolicyYaml({
    name: ORG_NAME, displayName: ORG_DISPLAY_NAME, domain: DOMAIN, persona: PERSONA,
    areasLabel: pick(a, 'VOCAB_AREAS_LABEL', 'Areas'),
    areas: splitList(pick(a, 'VOCAB_AREAS', '')),
    expertsLabel: pick(a, 'VOCAB_EXPERTS_LABEL', 'Experts'),
    experts: [],                                   // named later on the rock, not at setup
    tiers: splitTiers(pick(a, 'VOCAB_TIERS', '')),   // factory#2: name|description rows
    pulseEnabled: yn('PULSE_ENABLED', 'yes'), pulseName: 'Pulse', pulseLanding: 'notes/pulse/',
    heartbeats: mapWord('HEARTBEATS', 'minimal', { yes: 'minimal', true: 'minimal', no: 'off', false: 'off' }),
    region: REGION,
    dropsDirect: yn('DROPS_DIRECT', 'yes'),
    accessSsh: yn('ACCESS_SSH', 'yes'), accessBrowser: yn('ACCESS_BROWSER', 'yes'),
    admins: splitList(ROLE_ADMINS), support: splitList(pick(a, 'ROLE_SUPPORT', '')),
    contentUpdates: mapWord('LIFECYCLE_CONTENT', 'auto', { yes: 'auto', true: 'auto', no: 'manual', false: 'manual' }),
    images: mapWord('LIFECYCLE_IMAGES', 'pinned', { yes: 'pinned', true: 'pinned', no: 'latest', false: 'latest' }),
    leaverDays: String(pick(a, 'LEAVER_DAYS', '30')),
    outbound: OUTBOUND, aiDisclosure: yn('AI_DISCLOSURE', 'yes'),
    quietHours: '21:00-06:30', timezone: 'Australia/Sydney',
  });
  ctx.okw('org policy composed (vocabulary + permissions; invariants locked)');
  ctx.say('');

  ctx.b('3/5  Your cloud accounts');
  const HCLOUD_TOKEN = req('HCLOUD_TOKEN');
  const CF_API_TOKEN = req('CF_API_TOKEN');
  const GITHUB_TOKEN = req('GITHUB_TOKEN');
  let BRAIN_REPO = pick(a, 'BRAIN_REPO', '');
  if (!BRAIN_REPO) {
    const u = await gh(GITHUB_TOKEN, 'GET', '/user').catch(() => ({ status: 0, ok: false, json: null }));
    const code = u.status ? String(u.status) : '000';
    if (u.status !== 200) {
      ctx.die(`GitHub rejected the token while auto-naming your brain repo (HTTP ${code}).\n`
        + '  Common causes: the token was pasted with a stray space or newline; it expired; or a\n'
        + '  fine-grained token whose resource owner is not your account. Re-check the GitHub token on the cloud-accounts step and retry.');
    }
    const login = u.json?.login;
    if (!login) ctx.die('could not read your GitHub username from the token response');
    BRAIN_REPO = `git@github.com:${login}/${ORG_NAME}-brain.git`;
    ctx.okw(`brain repo auto-named: ${login}/${ORG_NAME}-brain`);
  }
  ctx.say('');

  ctx.b('4/5  Checking your credentials (read-only pings)');
  const hp = await http('GET', `${HC_API}/locations`, { token: HCLOUD_TOKEN }).catch(() => ({ ok: false }));
  if (!hp.ok) ctx.die('Hetzner token failed a read ping');
  ctx.okw('Hetzner token works');

  const cfp = await http('GET', `${CF_API}/zones?name=${DOMAIN}`, { token: CF_API_TOKEN }).catch(() => ({ ok: false, json: null }));
  if (!cfp.ok) ctx.die('Cloudflare token failed');
  const zoneSeen = Array.isArray(cfp.json?.result) && cfp.json.result.some((z) => z && z.name === DOMAIN);
  if (!zoneSeen) ctx.die(`Cloudflare token works but cannot see zone ${DOMAIN} (is the domain on this account, token scoped to it?)`);
  ctx.okw(`Cloudflare token sees ${DOMAIN}`);

  const RP = repoPathOf(BRAIN_REPO);
  const rex = await gh(GITHUB_TOKEN, 'GET', `/repos/${RP}`).catch(() => ({ ok: false, status: 0 }));
  let repoIsEmpty = false;
  if (rex.ok) {
    const head = await gh(GITHUB_TOKEN, 'GET', `/repos/${RP}/commits?per_page=1`).catch(() => ({ ok: false, status: 0 }));
    repoIsEmpty = !head.ok && head.status === 409;
    if (repoIsEmpty) ctx.mut(`brain repo ${RP} exists but is EMPTY (a stub from an earlier run); seeding it`);
    else {
      ctx.okw(`GitHub token sees ${RP}`);
      // Live-cert finding (2026-08-03): when the repo already has commits NEITHER
      // seed branch below fires, so answers changed before a retry (vocabulary,
      // persona, admins, region) never reach org-policy.yaml and the run says
      // nothing. Clobbering a live org's policy would be worse, so the fix is to
      // stop being silent: compare what this run composed against what is there,
      // and if they differ say so plainly and name the file that wins.
      const cur = await gh(GITHUB_TOKEN, 'GET', `/repos/${RP}/contents/org-policy.yaml`)
        .catch(() => ({ ok: false, json: null }));
      const existing = cur.ok && cur.json?.content
        ? Buffer.from(cur.json.content, 'base64').toString('utf8') : '';
      if (existing && existing.trim() !== String(orgPolicyYaml).trim()) {
        ctx.mut(`NOTE: ${RP} already has an org-policy.yaml and it differs from the answers you just gave.`);
        ctx.mut('      The existing policy STANDS: this run will not overwrite it, so any answer you changed');
        ctx.mut('      (vocabulary, persona, admins, region) is not applied. Edit org-policy.yaml in that repo,');
        ctx.mut('      or start a differently-named rock, if you meant the new answers to take effect.');
      }
    }
  }
  if (rex.ok && repoIsEmpty) {
    // the Git Data API cannot write to a zero-commit repo: bootstrap one commit first
    const boot = await gh(GITHUB_TOKEN, 'PUT', `/repos/${RP}/contents/README.md`,
      { message: 'bootstrap (wizard): initialise before seeding', content: Buffer.from(`# ${ORG_NAME}\n`).toString('base64') })
      .catch(() => ({ ok: false, status: 0 }));
    if (!boot.ok) ctx.die(`could not bootstrap the empty repo ${RP} (HTTP ${boot.status})`);
    const TEMPLATE_REPO = pick(a, 'TEMPLATE_REPO', process.env.AIOS_TEMPLATE_REPO);
    if (!TEMPLATE_REPO) ctx.die('no brain template configured (set TEMPLATE_REPO=<owner/repo>)');
    await seedBrainRepoFromTemplate(ctx, GITHUB_TOKEN, RP, TEMPLATE_REPO, ORG_NAME, { policyText: orgPolicyYaml });
    ctx.okw(`brain repo ${RP} seeded (was an empty stub)`);
  } else if (!rex.ok) {
    ctx.mut(`brain repo ${RP} does not exist yet; creating it from the template`);
    const owner = RP.split('/')[0];
    const name = RP.split('/').slice(1).join('/');
    const me = await gh(GITHUB_TOKEN, 'GET', '/user').catch(() => ({ ok: false, json: null }));
    const mine = me.ok && me.json?.login && me.json.login.toLowerCase() === owner.toLowerCase();
    const create = await gh(GITHUB_TOKEN, 'POST', mine ? '/user/repos' : `/orgs/${owner}/repos`,
      { name, private: true, auto_init: true, description: `${ORG_NAME} rock brain (created by the setup wizard)` })
      .catch(() => ({ ok: false }));
    if (!create.ok) ctx.die(`could not create ${RP} (token needs repo-create permission)`);
    const TEMPLATE_REPO = pick(a, 'TEMPLATE_REPO', process.env.AIOS_TEMPLATE_REPO);
    if (!TEMPLATE_REPO) {
      ctx.die('no brain template configured (set TEMPLATE_REPO=<owner/repo>; this engine seeds via the GitHub API, so the bash AIOS_TEMPLATE_DIR local-dir path does not apply)');
    }
    await seedBrainRepoFromTemplate(ctx, GITHUB_TOKEN, RP, TEMPLATE_REPO, ORG_NAME, { policyText: orgPolicyYaml });
    ctx.okw(`brain repo ${RP} created + seeded (org-policy.yaml + rendered identity overlaid)`);
  }
  ctx.say('');

  ctx.b('5/5  Standing up your rock box');
  const deploymentYaml = buildDeploymentYaml({
    ORG_NAME, OPERATORS, DOMAIN, BRAIN_REPO,
    CONTENT_REPO: pick(a, 'CONTENT_REPO', ''),
    PERSONA, REGION, FEAT_TELEGRAM, FEAT_VOICE, OUTBOUND,
    EXTRA_YAML: pick(a, 'EXTRA_YAML', ''),
  });
  ctx.okw('deployment.yaml written (staged config; nothing bakes)');

  // D40 parity with aios-setup.sh: mint the operator's access keypair; the public half
  // provisions onto the box (cloud-init __OPERATOR_PUBKEY__), the private half streams
  // to the operator ONLY via the __ACCESS_KEY__ markers below.
  const accessKey = generateDeployKeypair(`operator-${ORG_NAME}`);

  const result = await provisionRock(ctx, {
    // 2026-07-23: the slug names the Hetzner server (aios-<slug>), the CF tunnel
    // (aios-<slug>), AND the state file (rock-<slug>.env). The old default
    // 'rock' made every rock on one machine collide with the first
    // (live repro: a second org died with "rock 'rock' already provisioned").
    // The org name is validated to the same DNS-safe charset, so it IS the slug.
    slug: pick(a, 'SLUG', ORG_NAME),
    // the operator's chosen region, so the hub can sit near them too (see the
    // candidate ladder in provisionRock)
    region: REGION,
    deploymentYaml,
    image: pick(a, 'IMAGE', process.env.AIOS_IMAGE || DEFAULT_IMAGE),
    hcloudToken: HCLOUD_TOKEN, cfToken: CF_API_TOKEN, ghToken: GITHUB_TOKEN,
    operatorSshKeyName: pick(a, 'OPERATOR_SSH_KEY_NAME', process.env.OPERATOR_SSH_KEY_NAME || ''),
    operatorPubkey: accessKey.publicKey.replace(/\n+$/, ''),   // bash: $(cat access_key.pub)
    ghcrPullToken: pick(a, 'GHCR_PULL_TOKEN', process.env.GHCR_PULL_TOKEN || ''),
    stateDir: pick(a, 'STATE_DIR', process.env.AIOS_STATE_DIR),
    serverType: pick(a, 'SERVER_TYPE', process.env.HCLOUD_SERVER_TYPE || ''),
    location: pick(a, 'LOCATION', process.env.HCLOUD_LOCATION || ''),
    candidates: pick(a, 'CANDIDATES', process.env.HCLOUD_CANDIDATES || DEFAULT_CANDIDATES),
    templatePath: pick(a, 'CLOUD_INIT_TEMPLATE', DEFAULT_TEMPLATE_PATH),
  });

  // D40: on success, hand the operator their SSH config + private key, marker-for-marker
  // with the bash wizard (the UI turns the key block into the download button; the wizard
  // server redacts everything between the key markers from its log).
  ctx.say('__ACCESS_CONFIG_BEGIN__');
  ctx.say(`Host ${ORG_NAME}-rock`);
  ctx.say(`  HostName ${result.state.SERVER_IP}`);
  ctx.say('  User aios-op');
  ctx.say(`  IdentityFile ~/.ssh/${ORG_NAME}-rock.key`);
  ctx.say('__ACCESS_CONFIG_END__');
  ctx.say('__ACCESS_KEY_BEGIN__');
  for (const line of accessKey.privateKey.replace(/\n+$/, '').split('\n')) ctx.say(line);
  ctx.say('__ACCESS_KEY_END__');

  return result;
}

// ================================================================ provisioner
// provision-rock.sh, step for step. `ctx` may be a makeCtx() or an emit function.
export async function provisionRock(ctxOrEmit, cfg) {
  const ctx = typeof ctxOrEmit === 'function' ? makeCtx(ctxOrEmit) : ctxOrEmit;
  const { slug, deploymentYaml, image } = cfg;

  if (!slug || !VALID_SLUG_RE.test(slug)) ctx.die('slug must be DNS-safe: lowercase letters/digits/hyphens, 2-32 chars');
  if (!image) ctx.die('set AIOS_IMAGE to the rock image (e.g. ghcr.io/<you>/crads-rock:v2): refusing a default so a pebble image can never become a rock');
  if (!image.includes('crads-rock') && !image.includes('ai-os-parent')) ctx.die(`AIOS_IMAGE (${image}) is not a rock image (crads-rock, or the legacy ai-os-parent alias)`);
  for (const [k, v] of [['HCLOUD_TOKEN', cfg.hcloudToken], ['CF_API_TOKEN', cfg.cfToken], ['GITHUB_TOKEN', cfg.ghToken]]) {
    if (!v) ctx.die(`missing env var: ${k} (see provisioning/managed/README.md)`);
  }

  const stateDir = cfg.stateDir || join(REPO, 'provisioning', 'managed', 'state');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `rock-${slug}.env`);
  if (existsSync(statePath)) ctx.die(`a rock called '${slug}' was already built from this computer (its record is at ${statePath}). To rebuild it, delete the existing rock first (its control panel, Danger tab, "Delete this rock"). If its infrastructure is already gone, move that record file aside and try again.`);

  const deploymentName = dget(deploymentYaml, 'deployment_name');
  if (!deploymentName) ctx.die('deployment.yaml has no deployment_name');
  const domain = dget(deploymentYaml, 'domain');
  if (!domain) ctx.die('deployment.yaml has no domain');
  const brainRepo = dget(deploymentYaml, 'brain_repo');
  if (!brainRepo) ctx.die('deployment.yaml has no brain_repo');
  const brainRoot = dget(deploymentYaml, 'brain_root') || '/state/brain';
  const repoPath = repoPathOf(brainRepo);
  const hostname = `${slug}.${domain}`;
  const srvName = `aios-${slug}`;

  ctx.say(`Provisioning ROCK '${slug}' for deployment '${deploymentName}'`);
  ctx.say(`  url → https://${hostname} · image ${image} · brain ${repoPath} → ${brainRoot}`);
  ctx.say('');

  ctx.step('Resolving Cloudflare account + zone');
  const zone = await cfCall(ctx, cfg.cfToken, `find zone ${domain}`, 'GET', `${CF_API}/zones?name=${domain}`);
  const zoneId = zone?.[0]?.id;
  const accountId = zone?.[0]?.account?.id;
  if (!zoneId) ctx.die(`could not resolve zone id for ${domain} (is it on this Cloudflare account?)`);
  if (!accountId) ctx.die(`could not resolve account id from zone ${domain}`);
  ctx.ok(`account ${accountId} · zone ${domain} (${zoneId})`);

  ctx.step(`Minting a read-only deploy key for ${repoPath}`);
  const kp = generateDeployKeypair(`aios-rock-${slug}`);
  const dk = await gh(cfg.ghToken, 'POST', `/repos/${repoPath}/keys`,
    { title: `aios-rock-${slug} (read-only)`, key: kp.publicKey, read_only: true })
    .catch(() => ({ ok: false, json: null }));
  const dkId = dk.json?.id;
  if (!dkId) ctx.die(`deploy-key registration failed: ${dk.json?.message ?? 'unknown'}`);
  ctx.ok(`deploy key ${dkId} registered (read-only)`);

  // cleanup_partial parity: same order (server, DNS record, tunnel connections,
  // tunnel, deploy key), best-effort each, skipped once the state file exists.
  const live = { dkId, tunnelId: null, recordId: null, serverId: null, stateWritten: false };
  const rollback = async () => {
    if (live.stateWritten) return;
    ctx.say('rolling back partial provision…');
    // ctx.keepServer means the boot-wait could not PROVE what happened to the VM
    // (see hcWaitRunning). Deleting it here is what destroyed the evidence on
    // 2026-08-12 and turned an unproven "GONE" into a self-confirming one.
    if (live.serverId && ctx.keepServer) {
      ctx.say(`keeping server ${live.serverId}: the wait could not prove it was gone`);
    } else if (live.serverId) {
      await http('DELETE', `${HC_API}/servers/${live.serverId}`, { token: cfg.hcloudToken }).catch(() => {});
    }
    if (live.recordId) await http('DELETE', `${CF_API}/zones/${zoneId}/dns_records/${live.recordId}`, { token: cfg.cfToken }).catch(() => {});
    if (live.tunnelId) {
      await http('DELETE', `${CF_API}/accounts/${accountId}/cfd_tunnel/${live.tunnelId}/connections`, { token: cfg.cfToken }).catch(() => {});
      await http('DELETE', `${CF_API}/accounts/${accountId}/cfd_tunnel/${live.tunnelId}`, { token: cfg.cfToken }).catch(() => {});
    }
    if (live.dkId) await http('DELETE', `${GH_API}/repos/${repoPath}/keys/${live.dkId}`, { token: cfg.ghToken }).catch(() => {});
  };

  const password = randomBytes(18).toString('base64').replace(/[/+=]/g, '');

  let state; let chosen = '';
  try {
    ctx.step('Creating Cloudflare tunnel');
    const tun = await cfCall(ctx, cfg.cfToken, 'create tunnel', 'POST',
      `${CF_API}/accounts/${accountId}/cfd_tunnel`, { name: `aios-${slug}`, config_src: 'cloudflare' });
    live.tunnelId = tun?.id;
    if (!live.tunnelId) ctx.die('tunnel id missing from create response');
    ctx.ok(`tunnel ${live.tunnelId}`);

    const tunnelToken = await cfCall(ctx, cfg.cfToken, 'get tunnel token', 'GET',
      `${CF_API}/accounts/${accountId}/cfd_tunnel/${live.tunnelId}/token`);
    if (!tunnelToken || tunnelToken === 'null') ctx.die('tunnel token missing');

    // App-first (Sam, 2026-08-05): the hostname routes NOTHING. This is the self-serve
    // door's own path, so it is the one that mattered most: every stranger box built
    // since self-serve went live got a public https:// surface whose entire gate was one
    // shared code-server password, on a hostname derived from a name they typed into a
    // form. The tunnel and DNS record stay (teardown and the fleet snapshot key off them).
    ctx.step(`Routing ${hostname} → nothing (app-first: no browser door)`);
    await cfCall(ctx, cfg.cfToken, 'set ingress', 'PUT',
      `${CF_API}/accounts/${accountId}/cfd_tunnel/${live.tunnelId}/configurations`,
      { config: { ingress: [{ service: 'http_status:404' }] } });
    ctx.ok('ingress set (no public surface)');

    const rec = await cfCall(ctx, cfg.cfToken, 'create DNS record', 'POST',
      `${CF_API}/zones/${zoneId}/dns_records`,
      { type: 'CNAME', name: hostname, content: `${live.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });
    live.recordId = rec?.id;
    ctx.ok(`DNS CNAME ${hostname}`);

    // render cloud-init (in memory; the bash pair used a chmod-600 temp file)
    const ghOwner = repoPath.split('/')[0];
    const facB64 = factoryEnvB64({
      HCLOUD_TOKEN: cfg.hcloudToken, CF_API_TOKEN: cfg.cfToken, CF_ACCOUNT_ID: accountId,
      ROOT_DOMAIN: domain, CF_ZONE_NAME: domain, GITHUB_TOKEN: cfg.ghToken,
      GH_OWNER: ghOwner, OPERATOR_SSH_KEY_NAME: cfg.operatorSshKeyName || '',
     IMAGE: cfg.image });
    const template = readFileSync(cfg.templatePath || DEFAULT_TEMPLATE_PATH, 'utf8');
    const rendered = renderCloudInit(template, {
      PRIVATE_KEY: kp.privateKey,
      DEPLOYMENT_YAML: deploymentYaml,
      IDE_PASSWORD: password,
      TUNNEL_TOKEN: tunnelToken,
      IMAGE: image,
      BRAIN_REPO: brainRepo,
      BRAIN_ROOT: brainRoot,
      // NO PLATFORM CREDENTIAL ON CUSTOMER METAL (2026-08-20 audit). This was
      // `cfg.ghcrPullToken || cfg.ghToken`, so with no scoped token staged (and
      // none exists in the operator env) every rock this engine stamped carried
      // the platform's own GitHub PAT, repo + delete_repo scoped, into the
      // rendered cloud-init, /var/lib/cloud, and /root/.docker/config.json.
      // The product images are public on GHCR, so nothing needs a token here;
      // only an explicitly staged scoped one is used. Matches the same gate in
      // provisioning/rock/provision-rock.sh.
      GHCR_PULL_TOKEN: cfg.ghcrPullToken || '',
      FACTORY_ENV_B64: facB64,
      SSH_RULE: cfg.operatorSshKeyName ? 'ufw allow 22/tcp' : '/bin/true',
      OPERATOR_PUBKEY: cfg.operatorPubkey,   // D40; absent -> disabled placeholder
    });
    const ciBytes = Buffer.byteLength(rendered, 'utf8');
    if (ciBytes > 31000) ctx.die(`rendered cloud-init is ${ciBytes} B (>31 KiB cap)`);
    ctx.ok(`cloud-init rendered (${ciBytes} B of 32768)`);

    // Hetzner create, capacity-fallback walk (same pin override + candidate list)
    // Live-cert finding (2026-08-03): the candidate ladder was Europe-only, so an
    // operator who picked Asia-Pacific got their HUB in Germany. The region answer
    // legitimately governs member boxes (deployment.yaml default_region), but the
    // rock should sit near its operator too. Try the chosen region first, then
    // fall back to the standard ladder: on the real cert run three European
    // candidates were resource_unavailable in a row, so the fallback must survive.
    const ladder = String(cfg.candidates || DEFAULT_CANDIDATES).trim().split(/\s+/);
    const region = String(cfg.region || '').trim();
    const preferred = region && !ladder.some((c) => c.endsWith(`:${region}`))
      ? ['cx33', 'cpx32', 'cax21'].map((t) => `${t}:${region}`)
      : ladder.filter((c) => c.endsWith(`:${region}`));
    const cands = (cfg.serverType && cfg.location)
      ? [`${cfg.serverType}:${cfg.location}`]
      : [...preferred, ...ladder.filter((c) => !preferred.includes(c))];
    for (const cand of cands) {
      const st = cand.split(':')[0];
      const loc = cand.split(':').pop();
      ctx.step(`Creating Hetzner ${st} in ${loc}`);
      const body = {
        name: srvName, server_type: st, image: 'ubuntu-24.04', location: loc,
        start_after_create: true, public_net: { enable_ipv4: true, enable_ipv6: true },
        user_data: rendered,
        labels: { product: 'ai-os', role: 'rock', deployment: deploymentName, client: slug },
      };
      if (cfg.operatorSshKeyName) body.ssh_keys = [cfg.operatorSshKeyName];
      let cr;
      try { cr = await http('POST', `${HC_API}/servers`, { token: cfg.hcloudToken, body }); }
      catch { ctx.die(`Hetzner create failed (${st} @ ${loc}): request failed (network)`); }
      const sid = cr.json?.server?.id;
      if (sid) { live.serverId = sid; chosen = `${st} @ ${loc}`; ctx.ok(`server ${sid} (${chosen})`); break; }
      const ecode = cr.json?.error?.code ?? 'unknown';
      const emsg = cr.json?.error?.message ?? '';
      if (ecode === 'resource_unavailable' || (ecode === 'invalid_input' && /unsupported location/i.test(emsg))) {
        ctx.say(`  ${st} @ ${loc} unavailable (${ecode}), trying next`);
      } else {
        ctx.die(`Hetzner create failed (${st} @ ${loc}): ${ecode}: ${emsg}`);
      }
    }
    if (!live.serverId) ctx.die('no capacity for any candidate.');

    ctx.step('Waiting for the VM to boot');
    const ip = await hcWaitRunning(ctx, cfg.hcloudToken, live.serverId);
    ctx.ok(`running at ${ip}`);

    state = {
      SLUG: slug, ROLE: 'rock', DEPLOYMENT: deploymentName, HOSTNAME: hostname,
      SERVER_ID: String(live.serverId), SERVER_SPEC: chosen, SERVER_IP: ip,
      TUNNEL_ID: String(live.tunnelId), RECORD_ID: String(live.recordId ?? ''),
      DEPLOY_KEY_ID: String(dkId), BRAIN_REPO: repoPath,
      CF_ACCOUNT_ID: String(accountId), CF_ZONE_ID: String(zoneId),
    };
    writeFileSync(statePath, serializeState(state), { mode: 0o600 });
    live.stateWritten = true;
  } catch (err) {
    await rollback();
    throw err;
  }

  ctx.step('Waiting for the rock to come online (first boot pulls the image, up to ~12 min)');
  const readyState = await waitForBox(ctx, hostname);
  ctx.say('');
  // "reachable", not "live": the tunnel answering proves the VM booted and
  // cloudflared connected, which is all anyone can honestly claim from outside
  // a box whose browser door is shut.
  if (readyState === 'reachable') ctx.ok('rock is reachable (tunnel up)');
  else ctx.say('  ⚠ the tunnel never came up. Likely still pulling the image: check the URL in a few minutes.');

  ctx.say('');
  ctx.say('──────────────── the rock ────────────────');
  ctx.say(`  URL:      https://${hostname}`);
  ctx.say(`  Password: ${password}`);
  ctx.say('────────────────────────────────────────────');
  ctx.say("  Next: open it, sign into the deployment's Claude account (staging: yours, past the loud warning),");
  ctx.say('  stage the factory tokens (/state/secrets/provisioning.env.local), then stamp a pebble from the box.');
  ctx.say(`  Teardown: delete server ${state.SERVER_ID} + tunnel ${state.TUNNEL_ID} + DNS ${state.RECORD_ID} + deploy key ${state.DEPLOY_KEY_ID} (deprovision() does this from the state file).`);

  return { url: `https://${hostname}`, password, state, statePath, ready: readyState === 'reachable', deploymentYaml };
}

// ================================================================ deprovision
// deprovision-rock.sh: guarded teardown from the state file (or a parsed state
// object, or a bare slug resolved against the state dir). Confirmation required:
// opts.confirm === slug or AIOS_CONFIRM_DESTROY=<slug> (no TTY prompt here).
// Tokens come from opts.{HCLOUD_TOKEN,CF_API_TOKEN,GITHUB_TOKEN} or process.env.
export async function deprovision(stateOrPath, emit = (l) => console.log(l), opts = {}) {
  const ctx = makeCtx(emit);
  let statePath = null;
  let st;
  if (typeof stateOrPath === 'string') {
    let p = stateOrPath;
    if (!existsSync(p) && VALID_SLUG_RE.test(stateOrPath)) {
      const stateDir = opts.stateDir || process.env.AIOS_STATE_DIR || join(REPO, 'provisioning', 'managed', 'state');
      p = join(stateDir, `rock-${stateOrPath}.env`);
    }
    if (!existsSync(p)) ctx.die(`no setup record found at ${p}. Either there is nothing to tear down (already deleted or archived), or this is not the computer the rock was set up from: run the deletion there, or remove the infrastructure by hand in your Hetzner and Cloudflare dashboards.`);
    statePath = p;
    st = parseStateFile(readFileSync(p, 'utf8'));
  } else {
    st = { ...stateOrPath };
  }
  const slug = st.SLUG;
  if (!slug) ctx.die('state has no SLUG');
  const HCLOUD_TOKEN = opts.HCLOUD_TOKEN || process.env.HCLOUD_TOKEN;
  const CF_API_TOKEN = opts.CF_API_TOKEN || process.env.CF_API_TOKEN;
  const GITHUB_TOKEN = opts.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  for (const [k, v] of [['HCLOUD_TOKEN', HCLOUD_TOKEN], ['CF_API_TOKEN', CF_API_TOKEN], ['GITHUB_TOKEN', GITHUB_TOKEN]]) {
    if (!v) ctx.die(`missing env var: ${k} (see provisioning/managed/README.md)`);
  }

  ctx.say(`Tearing down ROCK '${slug}' (deployment: ${st.DEPLOYMENT || '?'})`);
  ctx.say(`  VM ${st.SERVER_ID} · tunnel ${st.TUNNEL_ID} · DNS ${st.RECORD_ID} · deploy key ${st.DEPLOY_KEY_ID || 'none'} · ${st.HOSTNAME}`);
  const confirm = opts.confirm || process.env.AIOS_CONFIRM_DESTROY || '';
  if (confirm !== slug) ctx.die('non-interactive and AIOS_CONFIRM_DESTROY does not match the slug: refusing');

  ctx.step(`Deleting Hetzner server ${st.SERVER_ID}`);
  const sd = await http('DELETE', `${HC_API}/servers/${st.SERVER_ID}`, { token: HCLOUD_TOKEN }).catch(() => ({ ok: false }));
  if (sd.ok) ctx.ok('server deleted'); else ctx.mut('server already gone');

  ctx.step('Deleting Cloudflare DNS + tunnel');
  const rd = await http('DELETE', `${CF_API}/zones/${st.CF_ZONE_ID}/dns_records/${st.RECORD_ID}`, { token: CF_API_TOKEN }).catch(() => ({ json: null }));
  if (rd.json?.success === true) ctx.ok('DNS record deleted'); else ctx.mut('record already gone');
  await http('DELETE', `${CF_API}/accounts/${st.CF_ACCOUNT_ID}/cfd_tunnel/${st.TUNNEL_ID}/connections`, { token: CF_API_TOKEN }).catch(() => {});
  const td = await http('DELETE', `${CF_API}/accounts/${st.CF_ACCOUNT_ID}/cfd_tunnel/${st.TUNNEL_ID}`, { token: CF_API_TOKEN }).catch(() => ({ json: null }));
  if (td.json?.success === true) ctx.ok('tunnel deleted'); else ctx.mut('tunnel already gone');

  if (st.DEPLOY_KEY_ID && st.BRAIN_REPO) {
    ctx.step(`Revoking deploy key ${st.DEPLOY_KEY_ID} on ${st.BRAIN_REPO}`);
    const kd = await http('DELETE', `${GH_API}/repos/${st.BRAIN_REPO}/keys/${st.DEPLOY_KEY_ID}`, { token: GITHUB_TOKEN }).catch(() => ({ ok: false }));
    if (kd.ok) ctx.ok('deploy key revoked'); else ctx.mut('key already gone');
  }

  // (The retire-the-handle-at-the-directory step went with the self-host strip,
  // 2026-09-01: the central directory is deleted, so there is no route record
  // left to retire and no name that can stay burned.)

  if (statePath) {
    const archived = `${statePath}.destroyed.${tsStamp()}`;
    renameSync(statePath, archived);
    ctx.ok('state archived (never deleted)');
  } else {
    ctx.mut('state was passed as an object; nothing on disk to archive');
  }
  ctx.say('Torn down. The brain repo and all git history are untouched: only infrastructure died.');
}
