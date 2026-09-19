// index.mjs: pick the harness a mineral named, check the pairing, run the turn.
//
// A mineral with no `assistant:` block (every mineral born before 2026-09-17) gets
// claude-code, exactly as before. Unknown ids and undeclared pairings are REFUSED with
// a sentence a member can act on; they never fall back silently to another harness,
// because "I asked for my local model and it quietly used a cloud one" is the one
// failure the private-inference case cannot survive.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const registry = JSON.parse(readFileSync(path.join(here, 'registry.json'), 'utf8'));

// profile.yaml is read leniently everywhere in the engine (no YAML dependency: the
// engine has zero runtime deps). Top-level `assistant:` block, two-space `harness:`,
// nested `model:` with four-space keys.
export function readAssistant(profileText = '') {
  const lines = String(profileText).split('\n');
  const start = lines.findIndex((l) => /^assistant:\s*(#.*)?$/.test(l));
  const out = { harness: registry.default, model: { source: 'signin', provider: 'anthropic' } };
  if (start < 0) return out;
  const val = (l) => l.replace(/^[^:]+:\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  let inModel = false;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;                       // next top-level key
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (/^ {2}harness:/.test(l)) { out.harness = val(l) || registry.default; inModel = false; }
    else if (/^ {2}model:\s*(#.*)?$/.test(l)) inModel = true;
    else if (/^ {2}\S/.test(l)) inModel = false;
    else if (inModel && /^ {4}[a-z_]+:/.test(l)) {
      const k = l.trim().split(':')[0]; const v = val(l);
      if (v !== '') out.model[k] = /^(timeout_s|context_tokens)$/.test(k) ? Number(v) : v;
    }
  }
  return out;
}

export async function getHarness(id) {
  if (!registry.harnesses.includes(id)) {
    throw new Error(`assistant.harness "${id}" is not one this mineral knows (it knows: ${registry.harnesses.join(', ')})`);
  }
  return import(`./${id}.mjs`);
}

export function checkPairing(manifest, model) {
  const ok = manifest.serves.some((s) => s.provider === model.provider && s.source === model.source);
  if (!ok) {
    const can = manifest.serves.map((s) => `${s.provider} (${s.source})`).join(', ');
    throw new Error(`the ${manifest.id} harness cannot think with ${model.provider} (${model.source}); it serves: ${can}`);
  }
}

// One turn. `spawnImpl(args, opts)` is the test seam (org-publish's `runClaude`).
export async function runTurn({ stateDir, cwd, prompt, grants, timeoutMs, spawnImpl }) {
  let profile = '';
  try { profile = readFileSync(path.join(stateDir, 'profile.yaml'), 'utf8'); } catch {}
  const assistant = readAssistant(profile);
  const h = await getHarness(assistant.harness);
  checkPairing(h.manifest, assistant.model);
  let mcpJson = '';
  try { mcpJson = readFileSync(path.join(stateDir, '.mcp.json'), 'utf8'); } catch {}
  const t = timeoutMs ?? (assistant.model.timeout_s > 0 ? assistant.model.timeout_s * 1000 : 240000);
  return h.run({ stateDir, cwd, prompt, grants, timeoutMs: t, spawnImpl, mcpJson, model: assistant.model });
}
