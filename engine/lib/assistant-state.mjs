// assistant-state.mjs: the ONE answer to "what does this mineral think with, and is it
// ready to think?" (spec 2026-09-17 §5.2). Same role claude-credential.mjs plays for the
// Claude sign-in, one level up: the cockpit row, the setup checklist, the heartbeat and the
// app all ask here, so they cannot disagree about one box.
//
// Three shapes of "ready", and they are not the same question:
//   claude-code            a Claude sign-in exists in .claude-auth
//   opencode + signin      OpenCode holds a credential for the named provider
//   opencode + endpoint    there is no sign-in at all; ready = the last probe of the URL
//                          passed (engine/ops/assistant-probe.mjs writes it). Never probed
//                          is `null`, which every caller must render as "not checked",
//                          never as "down".
//
// NOTHING SECRET LEAVES THIS MODULE. It reports presence, an account name where one is
// stored in the clear, and for an endpoint the HOST only: a base_url can carry a
// user:password or a token in its path, and this string ends up on an Overview card.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readAssistant, registry } from '../kernel/lib/harness/index.mjs';
import { readClaudeCredential } from './claude-credential.mjs';

export const PROBE_REL = ['.kernel', 'assistant-probe.json'];
const OPENCODE_AUTH_REL = ['.opencode-auth', 'data', 'opencode', 'auth.json'];

const PROVIDER_LABEL = {
  anthropic: 'Claude', openai: 'ChatGPT', 'github-copilot': 'GitHub Copilot',
  ollama: 'a model endpoint', 'openai-compatible': 'a model endpoint',
};
// The ONLY commands the app may autorun in a member's terminal. The app checks this
// list again on its side; a box is never trusted to name a command.
export const SIGNIN_COMMANDS = { 'claude-code': 'claude', opencode: 'opencode auth login' };

export function endpointHost(baseUrl) {
  try { const u = new URL(String(baseUrl)); return u.host || null; } catch { return null; }
}

function isLocalHost(host) {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return /^(localhost|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || /\.(local|lan|ts\.net)$/.test(h);
}

function readProbe(boxDir) {
  try { const j = JSON.parse(readFileSync(path.join(boxDir, ...PROBE_REL), 'utf8')); return (j && typeof j.ok === 'boolean') ? j : null; }
  catch { return null; }
}

function opencodeCredential(boxDir, provider) {
  // Presence of a non-empty entry for this provider. Never parsed further, never returned.
  try {
    const j = JSON.parse(readFileSync(path.join(boxDir, ...OPENCODE_AUTH_REL), 'utf8'));
    const e = j && j[provider];
    return !!(e && typeof e === 'object' && Object.keys(e).length);
  } catch { return false; }
}

/**
 * @param {string} boxDir the mineral's state dir
 * @returns {{harness, known, source, provider, label, ready: boolean|null, account: string|null,
 *            signinCommand: string|null, host: string|null, local: boolean|null, probe: object|null,
 *            rowName: string, status: string, wordsGo: string}}
 */
export function readAssistantState(boxDir) {
  const dir = boxDir || '.';
  let profile = ''; try { profile = readFileSync(path.join(dir, 'profile.yaml'), 'utf8'); } catch {}
  const a = readAssistant(profile);
  const known = registry.harnesses.includes(a.harness);
  const { source, provider } = a.model;
  const label = PROVIDER_LABEL[provider] || provider;
  const base = { harness: a.harness, known, source, provider, label, account: null, host: null, local: null, probe: null,
    signinCommand: source === 'signin' ? (SIGNIN_COMMANDS[a.harness] || null) : null };

  if (!known) {
    return { ...base, ready: false, rowName: 'Assistant on this mineral',
      status: `profile names a harness this mineral does not know ("${a.harness}")`, wordsGo: '' };
  }
  if (a.harness === 'claude-code') {
    const c = readClaudeCredential(dir);
    return { ...base, ready: c.present, account: c.account,
      // name kept verbatim: the app's gate matches it, and apps update independently of images
      rowName: 'Claude sign-in on this mineral',
      status: c.present ? 'signed in' + (c.account ? ' as ' + c.account : '') : 'not signed in yet · sign in from the Terminal tab',
      wordsGo: 'Thinking happens at Anthropic, on your Claude subscription.' };
  }
  if (source === 'signin') {
    const ok = opencodeCredential(dir, provider);
    return { ...base, ready: ok, rowName: 'Assistant sign-in on this mineral',
      status: ok ? `signed in to ${label}` : `not signed in to ${label} yet · sign in from the Terminal tab`,
      wordsGo: `Thinking happens at ${label}'s servers, on your own subscription.` };
  }
  const host = endpointHost(a.model.base_url);
  const probe = readProbe(dir);
  const local = host ? isLocalHost(host) : null;
  return { ...base, host, local, probe, ready: probe ? probe.ok : null,
    rowName: 'Assistant model endpoint',
    status: !host ? 'no endpoint address set'
      : probe === null ? `${host} · not checked yet`
      : probe.ok ? `${host} · answering (${a.model.id || 'model'})`
      : `${host} · ${probe.detail || 'not answering'}`,
    // Says where thinking happens and STOPS. "Nothing leaves your machine" is a claim about
    // the harness's own network calls that nobody has measured yet (spec §10 item 4).
    wordsGo: !host ? '' : `Thinking happens at ${host}${local ? ' (a private address)' : ''}. Connected services such as Google and your GitHub backup still see what you send them.` };
}

// CLI for the app's one-round-trip setup probe (wizard/panel/setup-steps.mjs):
//   node engine/lib/assistant-state.mjs <stateDir>  ->  SETUP_ASSISTANT {"harness":...}
// Facts only. No command, no path, no account: the door decides what to offer.
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = readAssistantState(process.argv[2] || '/state');
  console.log('SETUP_ASSISTANT ' + JSON.stringify({ harness: s.harness, source: s.source, provider: s.provider, label: s.label, ready: s.ready, host: s.host }));
}
