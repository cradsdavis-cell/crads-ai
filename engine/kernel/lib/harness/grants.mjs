// grants.mjs: what a job MAY do, as data, in no harness's vocabulary.
//
// WHY (spec 2026-09-17 §3.1). Default-deny outbound (D4) used to be enforced by
// which names appeared in one comma-separated string handed to one CLI. That is
// a fine mechanism and a terrible contract: a second harness would have had to
// reverse-engineer intent from "Skill,Read,Edit,Write,Glob,Grep". So the intent
// is stated here once, and each harness COMPILES it (claude-code.mjs to
// --allowedTools, opencode.mjs to a permission policy). Pure on purpose: the
// runner reads files, this decides.
//
//   files   true: read/edit/write/glob/grep inside the working directory
//           'read': read/glob/grep only (the company agent's Slack answers)
//   shell   run shell commands
//   skills  load a skill by name
//   mcp     [{ server, tool, raw }]  tool '*' = every tool on that server
//   addDirs extra directories the turn may touch (org-publish)
//   deny    [{ server, tool, raw }]  refused even if something else allows it
//   protect true: the turn may not write the files that configure a later turn
//           (job limits, cadence, skills, .mcp.json, settings, secrets)
import { derivePatterns } from '../mcp-allow.mjs';

// The explicit allow file and mcp-allow.mjs speak the Claude CLI's grammar
// (mcp__<server>__<tool|*>) because that was the only consumer. It stays the
// on-disk grammar; this is the one place it is parsed into neutral form. A
// pattern that does not parse keeps its `raw` (the Claude compiler still emits
// it, byte for byte as before) and gets server:null, which every OTHER compiler
// must treat as "grant nothing": unknown means denied.
const MCP_PATTERN = /^mcp__([A-Za-z0-9_-]+?)__(\*|[A-Za-z0-9_*-]+)$/;

export function parseMcpPattern(raw) {
  const m = MCP_PATTERN.exec(String(raw));
  return m ? { server: m[1], tool: m[2], raw } : { server: null, tool: null, raw };
}

// job -> grants. `message` (Telegram, voice) is the conversational channel: it
// may read and update the brain and load skills, and NOTHING that can reach the
// outside world: no shell, no MCP. That exclusion is D4 and it lives here now.
export function grantsForJob(job, { mcpJson = '', allowFile = '', limitsJson = '' } = {}) {
  if (job?.skill === 'message') return { files: true, shell: false, skills: true, mcp: [], addDirs: [] };
  const mcp = derivePatterns({ mcpJson, allowFile }).map(parseMcpPattern);
  return applyJobLimits({ files: true, shell: true, skills: true, mcp, addDirs: [] }, job?.skill, limitsJson);
}

// Job limits (2026-10-26). Every scheduled skill job gets every tool of every
// connected service plus a shell, so a job that only sorts and labels mail could
// still send it if an email talked it into trying. A member who wants that to be
// impossible, not just unlikely, writes <state>/cockpit/job-limits.json:
//
//   { "inbox-triage": { "shell": false,
//                       "tools": ["mcp__gmail__search_gmail_messages", "mcp__gmail__modify_gmail_message_labels"],
//                       "deny":  ["mcp__gmail__send_gmail_message"] },
//     "*":            { "deny":  ["mcp__xero__*"] } }
//
//   shell  false: no shell. Needed for "impossible": a shell can reach a service
//          with the stored token without going through any MCP tool.
//   tools  if present, the ONLY MCP tools the job gets (replaces "everything
//          connected"). MCP patterns only: a built-in like Bash here grants nothing.
//   deny   MCP patterns refused even if allowed; mcp__<server>__* drops the server.
//   "*"    applies to every scheduled job; a skill's own entry wins on shell and
//          tools, and the two deny lists add up.
//
// A limited job also may not write the files that would loosen its NEXT run
// (this file, the cadence, skills, .mcp.json): otherwise "rewrite your own limits"
// is the two-step way round them. A file that exists but does not parse fails
// CLOSED (no shell, no MCP) rather than silently restoring full access.
export function parseJobLimits(limitsJson) {
  if (!limitsJson || !String(limitsJson).trim()) return {};
  try {
    const doc = JSON.parse(limitsJson);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc;
  } catch {
    return { '*': { shell: false, tools: [] }, _invalid: true };
  }
}

const mcpOnly = (list) => (Array.isArray(list) ? list : []).map(parseMcpPattern).filter((m) => m.server);

export function applyJobLimits(grants, skill, limitsJson) {
  const doc = parseJobLimits(limitsJson);
  const star = doc['*'] && typeof doc['*'] === 'object' ? doc['*'] : {};
  const own = skill && skill !== '*' && doc[skill] && typeof doc[skill] === 'object' ? doc[skill] : {};
  const shell = own.shell ?? star.shell;
  const tools = Array.isArray(own.tools) ? own.tools : Array.isArray(star.tools) ? star.tools : null;
  const deny = [...mcpOnly(star.deny), ...mcpOnly(own.deny)];
  if (shell !== false && !tools && !deny.length) return grants;

  const deniedServers = new Set(deny.filter((d) => d.tool === '*').map((d) => d.server));
  const deniedRaw = new Set(deny.map((d) => d.raw));
  const mcp = (tools ? mcpOnly(tools) : grants.mcp)
    .filter((m) => !deniedServers.has(m.server) && !deniedRaw.has(m.raw));
  return { ...grants, shell: shell === false ? false : grants.shell, mcp, deny, protect: true };
}

// org-publish: files only, plus the one extra directory it writes extracts into.
export function grantsForOrgPublish(orgDir) {
  return { files: true, shell: false, skills: false, mcp: [], addDirs: [orgDir] };
}

// Teams (2026-10-10): the company agent answering in Slack. It reads the company
// brain and nothing else: no edits, no shell, no skills, no MCP. Its cwd is the
// brain clone, so that is all it can see; anything it wants changed comes back as
// a proposal block the bridge queues for the owner.
export function grantsForSlackAnswer() {
  return { files: 'read', shell: false, skills: false, mcp: [], addDirs: [] };
}
