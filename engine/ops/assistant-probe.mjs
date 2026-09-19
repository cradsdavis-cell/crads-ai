// assistant-probe.mjs: can this endpoint actually run an assistant? (spec 2026-09-17 §5.1)
//
// Run on the mineral:  node engine/ops/assistant-probe.mjs <stateDir>
// Probes FROM THE BOX, because "reachable from my laptop" says nothing about a mineral in a
// data centre dialling a GPU box at home. Writes <stateDir>/.kernel/assistant-probe.json,
// which assistant-state.mjs reads as "ready".
//
// Three checks, in the order they fail in the wild:
//   1 reachable   the address answers at all
//   2 model       the named model is one the server lists (skipped, not failed, when the
//                 server has no /models: several do not)
//   3 tool call   one real round trip that must come back as a well-formed tool call.
//                 This is the one that matters. The most reported local-model failure is a
//                 server or model that answers chat perfectly and drops or mangles tool
//                 calls, which for this product means every skill silently does nothing.
// NOT checked: context window. There is no portable way to ask an OpenAI-compatible server
// for it, and a guessed number is worse than none. The docs state the 32K floor instead.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { readAssistant } from '../kernel/lib/harness/index.mjs';
import { PROBE_REL } from '../lib/assistant-state.mjs';

const TOOL = { type: 'function', function: { name: 'report_ready', description: 'Report that you are ready.',
  parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] } } };

async function call(fetchImpl, url, { method = 'GET', key, body, timeoutMs }) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method, signal: ac.signal, body: body ? JSON.stringify(body) : undefined,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) } });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}

export async function probeEndpoint({ base_url, id, key = '', fetchImpl = fetch, timeoutMs = 120000 }) {
  const steps = []; const base = String(base_url).replace(/\/$/, '');
  const fail = (detail) => ({ ok: false, detail, steps });
  let m;
  try { m = await call(fetchImpl, `${base}/models`, { key, timeoutMs: Math.min(timeoutMs, 15000) }); }
  catch (e) { return fail(e.name === 'AbortError' ? 'no answer within 15 seconds' : 'could not connect from this mineral'); }
  if (m.status === 401 || m.status === 403) return fail('the endpoint refused the key');
  steps.push('reachable');
  const ids = Array.isArray(m.json?.data) ? m.json.data.map((x) => x && x.id).filter(Boolean) : null;
  if (ids && ids.length && !ids.includes(id)) return fail(`the endpoint does not list a model named "${id}" (it lists: ${ids.slice(0, 6).join(', ')})`);
  steps.push(ids && ids.length ? 'model listed' : 'model list not offered');
  let c;
  try {
    c = await call(fetchImpl, `${base}/chat/completions`, { method: 'POST', key, timeoutMs, body: { model: id, stream: false, tools: [TOOL], tool_choice: 'required',
      messages: [{ role: 'user', content: 'Call the report_ready tool with ready set to true. Do not reply with text.' }] } });
  } catch (e) { return fail(e.name === 'AbortError' ? `the model took longer than ${Math.round(timeoutMs / 1000)} seconds to answer one short request` : 'the connection dropped while the model was answering'); }
  if (c.status >= 400) return fail(`the endpoint answered ${c.status} to a chat request${c.json?.error?.message ? ': ' + String(c.json.error.message).slice(0, 140) : ''}`);
  const tc = c.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc || tc.function?.name !== 'report_ready') return fail('the model answered in words instead of calling a tool; skills need tool calls, so this model or server cannot run them');
  try { const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; if (typeof args !== 'object' || args === null) throw 0; }
  catch { return fail('the model called the tool with arguments that are not valid JSON'); }
  steps.push('tool call');
  return { ok: true, detail: '', steps };
}

export async function probeMineral(stateDir, { fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  let profile = ''; try { profile = readFileSync(path.join(stateDir, 'profile.yaml'), 'utf8'); } catch {}
  const { model } = readAssistant(profile);
  if (model.source !== 'endpoint') return { ok: null, detail: 'this mineral does not use a model endpoint', steps: [] };
  let key = '';
  if (model.key_ref) { try { key = readFileSync(path.join(stateDir, 'secrets', path.basename(model.key_ref)), 'utf8').trim(); } catch {} }
  const timeoutMs = (model.timeout_s > 0 ? model.timeout_s : 120) * 1000;
  const r = { ...(await probeEndpoint({ base_url: model.base_url, id: model.id, key, fetchImpl, timeoutMs })), at: now() };
  const f = path.join(stateDir, ...PROBE_REL); mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(r) + '\n'); renameSync(f + '.tmp', f);
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await probeMineral(process.argv[2] || '/state');
  console.log('ASSISTANT_PROBE ' + JSON.stringify(r));
}
