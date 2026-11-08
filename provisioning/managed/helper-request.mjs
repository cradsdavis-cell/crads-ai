#!/usr/bin/env node
// helper-request.mjs: make a signed helper-access request for ONE member's mineral.
//
// Operator side (spec docs/superpowers/specs/2026-11-08-helper-access-design.md).
// Signs with the request key on this box; the member's mineral verifies it
// against engine/support/request-signers and shows the member who, why and for
// how long before anything opens. Nothing here touches any box or any API: it
// prints a link and a code, and the helper sends them to their client.
//
//   node provisioning/managed/helper-request.mjs \
//     --name "Rhys Morgan" --org "Example Builds" --email rhys@example.com \
//     --key ~/rhys.pub \
//     --member-email client@example.com        (or --mineral min_<24 hex>) \
//     --days 21                                 (or --hours 1..72) \
//     --purpose "Build the invoice-chasing automation agreed on 4 Dec" \
//     [--answer-within 7] [--signing-key ~/.ssh/crads_helper_request]
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { encodeRequest, linkFor, requestBytes, shapeProblem, NAMESPACE } from '../../engine/support/grants.mjs';
import { fingerprintOf } from '../../engine/devices/roster.mjs';

export function buildRequest(o, now = new Date()) {
  const keyArg = String(o.key || '');
  const key = (existsSync(keyArg) ? readFileSync(keyArg, 'utf8') : keyArg).trim().split('\n')[0].trim();
  const within = Math.max(1, Math.min(7, parseInt(o['answer-within'] || '7', 10) || 7));
  const r = {
    v: 1,
    id: 'req_' + randomBytes(8).toString('hex'),
    helper: { name: String(o.name || '').trim(), org: String(o.org || '').trim(), email: String(o.email || '').trim(), key },
    for: o.mineral ? { mineral_id: String(o.mineral).trim() } : { email: String(o['member-email'] || '').trim().toLowerCase() },
    purpose: String(o.purpose || '').trim(),
    issued_at: now.toISOString(),
    approve_by: new Date(now.getTime() + within * 86400_000).toISOString(),
  };
  if (!r.helper.email) delete r.helper.email;
  if (o.days != null) r.days = parseInt(o.days, 10); else r.hours = parseInt(o.hours, 10);
  return r;
}

export function signRequest(r, signingKey) {
  const problem = shapeProblem(r);
  if (problem) throw new Error(problem);
  const dir = mkdtempSync(join(tmpdir(), 'crads-req-'));
  try {
    const msg = join(dir, 'req.json');
    const bytes = requestBytes(r);
    writeFileSync(msg, bytes);
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', signingKey, '-n', NAMESPACE, msg], { stdio: ['ignore', 'pipe', 'pipe'] });
    const sig = readFileSync(msg + '.sig', 'utf8');
    return encodeRequest(bytes, sig);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    o[k] = v;
  }
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = parseArgs(process.argv.slice(2));
  const signingKey = o['signing-key'] || join(homedir(), '.ssh', 'crads_helper_request');
  try {
    if (!existsSync(signingKey)) throw new Error(`no signing key at ${signingKey}`);
    const r = buildRequest(o);
    const code = signRequest(r, signingKey);
    console.log(`Helper:   ${r.helper.name}${r.helper.org ? ` (${r.helper.org})` : ''}  key ${fingerprintOf(r.helper.key)}`);
    console.log(`For:      ${r.for.mineral_id || r.for.email}`);
    console.log(`Access:   ${r.days != null ? `${r.days} day(s)` : `${r.hours} hour(s)`} from approval`);
    console.log(`Purpose:  ${r.purpose}`);
    console.log(`Answer by ${r.approve_by.slice(0, 10)} (id ${r.id})`);
    console.log('');
    console.log('Link (opens the Crads-AI app on the approve screen):');
    console.log(linkFor(code));
    console.log('');
    console.log('Or paste this code into Help > Helper access > Paste a request:');
    console.log(code);
  } catch (e) {
    console.error('ERROR: ' + (e.message || e));
    process.exit(1);
  }
}
