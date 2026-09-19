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
//   files   read/edit/write/glob/grep inside the working directory
//   shell   run shell commands
//   skills  load a skill by name
//   mcp     [{ server, tool, raw }]  tool '*' = every tool on that server
//   addDirs extra directories the turn may touch (org-publish)
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
export function grantsForJob(job, { mcpJson = '', allowFile = '' } = {}) {
  if (job?.skill === 'message') return { files: true, shell: false, skills: true, mcp: [], addDirs: [] };
  const mcp = derivePatterns({ mcpJson, allowFile }).map(parseMcpPattern);
  return { files: true, shell: true, skills: true, mcp, addDirs: [] };
}

// org-publish: files only, plus the one extra directory it writes extracts into.
export function grantsForOrgPublish(orgDir) {
  return { files: true, shell: false, skills: false, mcp: [], addDirs: [orgDir] };
}
