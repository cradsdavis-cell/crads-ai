// assistant-set.mjs: the ONE writer of profile.yaml's `assistant:` block (spec 2026-09-17 §5.1).
// The wizard and the app's "What your mineral thinks with" card both end here, so a
// value that could not run never reaches disk.
//
// Run on the mineral:  node engine/ops/assistant-set.mjs <stateDir> -     (base64 JSON on stdin)
//   JSON = { harness, source, provider, id?, base_url?, key_ref?, key?, timeout_s? }
//   `key` (optional) is written to <stateDir>/secrets/<key_ref> mode 0600 and NEVER to
//   the profile. base64url because this rides an SSH command line: no quoting to get wrong.
//
// Everything is validated against the harness REGISTRY and the harness's own manifest, the
// same check the runner makes at turn time. Refusals are sentences a member can act on.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getHarness, checkPairing, registry } from '../kernel/lib/harness/index.mjs';
import { PROBE_REL } from '../lib/assistant-state.mjs';

const ID_RE = /^[A-Za-z0-9._:\/@-]{1,120}$/;
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function validate(input) {
  const a = input && typeof input === 'object' ? input : {};
  const harness = String(a.harness || '');
  if (!registry.harnesses.includes(harness)) throw new Error(`"${harness}" is not a harness this mineral knows (it knows: ${registry.harnesses.join(', ')})`);
  const source = String(a.source || ''), provider = String(a.provider || '');
  if (!['signin', 'endpoint'].includes(source)) throw new Error('source must be signin or endpoint');
  checkPairing((await getHarness(harness)).manifest, { source, provider });
  const out = { harness, source, provider };
  if (a.id != null && a.id !== '') { if (!ID_RE.test(String(a.id))) throw new Error('that model name has characters a model name cannot have'); out.id = String(a.id); }
  if (source === 'endpoint') {
    if (!out.id) throw new Error('an endpoint needs the name of the model to ask for');
    let u; try { u = new URL(String(a.base_url || '')); } catch { throw new Error('that endpoint address is not a web address (it should look like http://192.168.1.20:11434/v1)'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('an endpoint address must start with http:// or https://');
    if (/\s/.test(String(a.base_url)) || u.username || u.password) throw new Error('put the key in the key box, not inside the address');
    out.base_url = u.toString().replace(/\/$/, '');
    if (a.key_ref != null && a.key_ref !== '') { if (!REF_RE.test(String(a.key_ref))) throw new Error('a key name may hold letters, digits, dot, dash and underscore only'); out.key_ref = String(a.key_ref); }
    if (a.key != null && a.key !== '' && !out.key_ref) out.key_ref = 'assistant_endpoint_key';
  }
  if (a.timeout_s != null && a.timeout_s !== '') {
    const t = Number(a.timeout_s);
    if (!Number.isInteger(t) || t < 30 || t > 3600) throw new Error('the per-turn time limit must be between 30 seconds and one hour');
    out.timeout_s = t;
  }
  return out;
}

export function renderBlock(a) {
  const q = (v) => JSON.stringify(String(v));   // JSON strings are valid YAML double-quoted scalars
  const L = ['assistant:', `  harness: ${a.harness}`, '  model:', `    source: ${a.source}`, `    provider: ${a.provider}`];
  if (a.id) L.push(`    id: ${q(a.id)}`);
  if (a.base_url) L.push(`    base_url: ${q(a.base_url)}`);
  if (a.key_ref) L.push(`    key_ref: ${q(a.key_ref)}`);
  if (a.timeout_s) L.push(`    timeout_s: ${a.timeout_s}`);
  return L.join('\n') + '\n';
}

// Replace the existing top-level block in place (its position in the file is the member's),
// or append one. Every other byte of the profile is left alone.
export function applyAssistant(profileText, a) {
  const lines = String(profileText || '').split('\n');
  const start = lines.findIndex((l) => /^assistant:\s*(#.*)?$/.test(l));
  const block = renderBlock(a);
  if (start < 0) return String(profileText || '').trim() ? String(profileText).replace(/\n*$/, '\n\n') + block : block;
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  while (end > start + 1 && /^\s*$/.test(lines[end - 1])) end--;   // keep the blank line(s) before the next key
  return [...lines.slice(0, start), ...block.replace(/\n$/, '').split('\n'), ...lines.slice(end)].join('\n');
}

export async function setAssistant(stateDir, input) {
  const a = await validate(input);
  if (input.key != null && input.key !== '') {
    const key = String(input.key).trim();
    if (/[\r\n]/.test(key)) throw new Error('a key is a single line');
    const dir = path.join(stateDir, 'secrets'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, a.key_ref); writeFileSync(f + '.tmp', key + '\n', { mode: 0o600 }); chmodSync(f + '.tmp', 0o600); renameSync(f + '.tmp', f);
  }
  const p = path.join(stateDir, 'profile.yaml');
  let cur = ''; try { cur = readFileSync(p, 'utf8'); } catch {}
  writeFileSync(p + '.tmp', applyAssistant(cur, a)); renameSync(p + '.tmp', p);
  // A probe result describes the OLD endpoint. Leaving it would show "answering" for an
  // address nobody has tried.
  rmSync(path.join(stateDir, ...PROBE_REL), { force: true });
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [stateDir, b64] = process.argv.slice(2);
  try {
    if (!stateDir || !b64) throw new Error('usage: assistant-set.mjs <stateDir> <base64 JSON | ->');
    // '-' = read it from stdin. The app always uses this form: the payload can carry a key,
    // and a process argument is readable by every user on the box for as long as it runs.
    const raw = b64 === '-' ? readFileSync(0, 'utf8').trim() : b64;
    const a = await setAssistant(stateDir, JSON.parse(Buffer.from(raw, 'base64').toString('utf8')));
    console.log('ASSISTANT_SET ' + JSON.stringify(a));
  } catch (e) { console.log('ASSISTANT_REFUSED ' + String(e.message || e).replace(/\s+/g, ' ')); process.exit(2); }
}
