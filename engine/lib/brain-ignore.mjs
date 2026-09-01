// brain-ignore.mjs — the node reader for engine/lib/brain-ignore.txt.
//
// One truth, two readers: the shell paths (connect-github.sh, brain-push.sh,
// box-up.sh) parse the .txt directly, and node callers come through here. See
// the .txt's own header for what went wrong and why a copy is not acceptable.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const LIST = process.env.AIOS_BRAIN_IGNORE
  || path.join(path.dirname(new URL(import.meta.url).pathname), 'brain-ignore.txt');

const parse = (raw, requiredOnly) => {
  const out = [];
  for (const line of String(raw).split('\n')) {
    if (requiredOnly && /^# --- repaired/.test(line)) break;
    const t = line.replace(/#.*/, '').trim();
    if (t) out.push(t);
  }
  return out;
};

/** Every never-commit glob. Falls back to the credential floor if the file is
 *  unreadable, so a caller can never silently seed an EMPTY ignore set: that is
 *  the failure this whole file exists to prevent. */
export function brainIgnores() {
  try { return parse(readFileSync(LIST, 'utf8'), false); }
  catch { return brainRequired(); }
}

/** The refusal floor: brain-push.sh will not push a tree missing any of these. */
export function brainRequired() {
  try { return parse(readFileSync(LIST, 'utf8'), true); }
  catch { return ['.env', '.env.*', 'secrets/', '*.key', '*.pem', '.ssh/', 'ssh/', '.claude-auth/', '.kernel/', '.mcp.json']; }
}
