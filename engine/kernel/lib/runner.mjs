// runner.mjs — executes one job (a skill run).
//
// LIVE mode shells out to Claude Code headless (`claude -p`) inside the client's
// state dir, authed via that instance's own Claude subscription (decisions D2)
// using an isolated CLAUDE_CONFIG_DIR. DRY_RUN mode produces deterministic output
// so the kernel / concurrency / persistence spine is testable with no auth and
// no usage — flip DRY_RUN off to go live.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { derivePatterns } from './mcp-allow.mjs';
import { localDate } from '../../lib/clock.mjs';   // injectable clock (spec §0.5) — brief stamps client-LOCAL virtual date

// Run Claude Code headless with stdin CLOSED (headless must not wait on stdin) and a
// hard timeout (a hung turn must not block the kernel forever).
function runClaude(args, { cwd, env, timeoutMs = 240000 }) {
  return new Promise((resolve, reject) => {
    const pebble = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { pebble.kill('SIGKILL'); reject(new Error(`claude timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pebble.stdout.on('data', (d) => { out += d; });
    pebble.stderr.on('data', (d) => { err += d; });
    pebble.on('error', (e) => { clearTimeout(t); reject(e); });
    pebble.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err || `claude exited ${code}`).slice(0, 300))); });
  });
}

export async function runSkill(stateDir, job, { dryRun = false } = {}) {
  // onboard-ingest is DETERMINISTIC engine code (the seeded path) — run it in both dry and
  // live mode, never via the LLM. The live LLM /onboard is a separate (chaos-tier) skill.
  if (job.skill === 'onboard-ingest') {
    const { ingest } = await import('../../lib/onboard-ingest.mjs');
    const r = ingest(stateDir);
    return { ok: true, output: `ingested brain: ${r.facts} facts, ${r.modules} modules -> ${r.index_path}` };
  }
  if (job.skill === 'pack1') {   // B1 Pack 1 Starter — deterministic build from the brain
    const { generate } = await import('../../lib/pack1.mjs');
    const r = generate(stateDir);
    return { ok: true, output: `built Pack 1: ${r.prompts} starter prompts (foundation ${r.foundation_ok ? 'ok' : 'incomplete'}) -> ${r.deliverable}` };
  }
  if (job.skill === 'pack2') {   // B2 Pack 2 Make-it-theirs — bespoke skill for pain1
    const { generate } = await import('../../lib/pack2.mjs');
    const r = generate(stateDir);
    return { ok: true, output: `built bespoke skill /${r.skill} for ${r.addresses} (${r.entities} client entities) -> ${r.deliverable}` };
  }
  if (job.skill === 'pack3') {   // B3 Pack 3 Connect-it — connect demo (mocked integrations)
    const { generate } = await import('../../lib/pack3.mjs');
    const r = generate(stateDir);
    return { ok: true, output: `connect demo: ${r.provider} (${r.mcp_server}) health=${r.health_ok ? 'ok' : 'fail'} ${r.records} records; triaged ${r.triaged} -> ${r.deliverable}` };
  }
  if (job.skill === 'pack4') {   // B4 Pack 4 Run-your-week — cadence + autonomy + handover
    const { generate } = await import('../../lib/pack4.mjs');
    const r = generate(stateDir);
    return { ok: true, output: `handover: cadence ${r.cadence_live ? 'live' : 'off'}, ${r.autonomy} auto actions, owns_repo=${r.owns_repo} (complete=${r.complete}) -> ${r.deliverable}` };
  }
  if (job.skill === 'org-publish') {   // org-brain spine — deterministic dry, claude live (spec 2026-07-25)
    const { publish } = await import('../../lib/org-publish.mjs');
    return publish(stateDir, { dryRun });
  }
  if (dryRun) return runDry(stateDir, job);

  // LIVE: invoke Claude Code headless. Auth = the client's own subscription,
  // isolated to this instance via CLAUDE_CONFIG_DIR.
  // job.skill === 'prompt' passes job.args.text straight through (used for the
  // first live smoke test); otherwise it asks Claude Code to run the named skill.
  // Build the prompt + tool allowlist per job type.
  let prompt;
  let allowed = 'Skill,Bash,Read,Edit,Write,Glob,Grep';
  if (job.skill === 'message') {
    // Conversational turn from the client (Telegram, D11 secondary channel).
    // DEFAULT-DENY outbound (D4): restricted tools — read/update the brain + run
    // skills, but NO send tools. Anything to send is DRAFTED + flagged
    // PROPOSE-SEND so the adapter surfaces Approve/Deny buttons.
    allowed = 'Skill,Read,Edit,Write,Glob,Grep';
    prompt =
      `You are the client's AI assistant. They sent you this message — respond helpfully and conversationally. ` +
      `You may read and update their brain (the wiki) and use their skills. ` +
      `You must NOT send anything externally (no emails, DMs, or messages). ` +
      `If something should be sent on their behalf, DRAFT it in your reply and add a final line exactly ` +
      `"PROPOSE-SEND: <one-line summary>" so it can be surfaced for approval. Do not run git.\n\n` +
      `Client message: ${job.args?.text || ''}`;
  } else if (job.skill === 'execute-proposal') {
    // An approved outbound action. Execution (actually sending) lands with MCP wiring.
    return { ok: true, output: '(approved action — execution is wired at the MCP phase)' };
  } else if (job.skill === 'prompt') {
    prompt = String(job.args?.text || 'Reply with exactly: AI OS live.');
  } else {
    prompt =
      `Run the /${job.skill} skill for this AI OS instance. ` +
      `Args: ${JSON.stringify(job.args || {})}. ` +
      `Read profile.yaml + the wiki; perform exactly the file changes the skill defines. ` +
      `Do not run git — the kernel commits.`;
  }
  // Give SKILL jobs the registered MCP tools (live data, written by connect.mjs to
  // .kernel/mcp-allow). 'message' jobs stay restricted — default-deny outbound (D4)
  // means the conversational channel never gets send-capable MCP tools.
  if (job.skill !== 'message') {
    // Derived from the box's OWN .mcp.json, plus the explicit file. See
    // lib/mcp-allow.mjs for why this is derived rather than hand-written: a
    // member who connects a service in the Claude Code app does everything right
    // and their jobs still could not call it. D4 is untouched — 'message' jobs
    // are excluded here exactly as before, so the conversational channel still
    // gets no MCP tools.
    const read = async (p) => { try { return await readFile(path.join(stateDir, ...p), 'utf8'); } catch { return ''; } };
    const patterns = derivePatterns({
      mcpJson: await read(['.mcp.json']),
      allowFile: await read(['.kernel', 'mcp-allow']),
    });
    if (patterns.length) allowed += ',' + patterns.join(',');
  }
  // acceptEdits auto-approves file edits (headless can't answer prompts); allowedTools
  // pre-approves the tool set so non-approved tools abort instead of prompting.
  // Auth (D11 corrected): the autonomous/cron path MUST pin CLAUDE_CONFIG_DIR to the box's own
  // .claude-auth, exactly like the interactive launchers — otherwise headless claude defaults to
  // $HOME/.claude, which on a shared-VPS operator host IS the operator's account (the cross-client
  // identity leak). Pinning it here means no caller (cron, kernel, telegram) can forget it.
  const cliArgs = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', allowed];
  const stdout = await runClaude(cliArgs, { cwd: stateDir, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(stateDir, '.claude-auth') }, timeoutMs: 240000 });
  return { ok: true, output: stdout.slice(0, 4000) };
}

// Minimal real behaviour so a dry run still exercises read+write of the wiki.
async function runDry(stateDir, job) {
  if (job.skill === 'message') return { ok: true, output: `dry: would reply to "${String(job.args?.text || '').slice(0, 40)}"` };
  if (job.skill === 'execute-proposal') return { ok: true, output: '(approved action — stub)' };
  if (job.skill === 'prompt') return { ok: true, output: `dry: prompt "${String(job.args?.text || '').slice(0, 40)}"` };
  if (job.skill === 'daily') {
    let priorities = '(none found)';
    try { priorities = await readFile(path.join(stateDir, 'wiki', 'priorities.md'), 'utf8'); } catch {}
    // client-LOCAL date in the profile's timezone, from the injectable clock (no wall-clock leak).
    let tz = 'UTC';
    try { tz = (await readFile(path.join(stateDir, 'profile.yaml'), 'utf8')).match(/timezone:\s*"?([^"\n]+)"?/)?.[1]?.trim() || 'UTC'; } catch {}
    const date = localDate(stateDir, tz);
    const top = priorities.split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 3);
    const brief =
      `# Daily Brief — ${date}  (DRY_RUN)\n\n` +
      `_Produced by the kernel without invoking Claude Code (spine test)._\n\n` +
      `## Top 3 (from priorities.md)\n${top.length ? top.join('\n') : '- (no priorities listed)'}\n`;
    await mkdir(path.join(stateDir, 'wiki'), { recursive: true });
    await writeFile(path.join(stateDir, 'wiki', 'daily-brief.md'), brief);
    // ledger the brief as a comm: client's-own-Telegram brief -> §0.4 auto-send allowlist.
    try { const { emit } = await import('../../lib/comms.mjs'); emit(stateDir, { comm_id: `${path.basename(path.dirname(stateDir))}:C13:brief:${date}`, comm_type: 'brief', channel: 'telegram', recipient_class: 'client_self', trigger: { kind: 'cron', trigger_id: 'morning_brief' }, subject: null, body: brief }); } catch {}
    return { ok: true, output: 'wrote wiki/daily-brief.md (dry)' };
  }
  return { ok: true, output: `dry: no handler for '${job.skill}', no-op` };
}
