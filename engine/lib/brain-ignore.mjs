// brain-ignore.mjs — the node reader for engine/lib/brain-ignore.txt.
//
// One truth, two readers: the shell paths (connect-github.sh, brain-push.sh,
// box-up.sh) parse the .txt directly, and node callers come through here. See
// the .txt's own header for what went wrong and why a copy is not acceptable.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAdopted } from './mineral-identity.mjs';

const LIST = process.env.AIOS_BRAIN_IGNORE
  || path.join(path.dirname(new URL(import.meta.url).pathname), 'brain-ignore.txt');

// The last section names engine files an adopted brain must never commit but a
// pebble versions on purpose, so the full (non-adopted) set skips it.
const ADOPTED_ONLY_SECTION = /adopted brain only/;

const parse = (raw, requiredOnly) => {
  const out = []; let skip = false;
  for (const line of String(raw).split('\n')) {
    if (requiredOnly && /^# --- repaired/.test(line)) break;
    if (/^# --- /.test(line)) skip = ADOPTED_ONLY_SECTION.test(line);
    if (skip) continue;
    const t = line.replace(/#.*/, '').trim();
    if (t) out.push(t);
  }
  return out;
};

/** Every never-commit glob for a brain that is not adopted (the adopted-only
 *  section left out). Falls back to the credential floor if the file is
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

/** Every entry except the section an adopted brain tracks itself (.claude/,
 *  cockpit/), the adopted-only section included. Until the adopt rehearsal (2026-10-18) an adopted brain got the
 *  credential floor ONLY, so .opencode-auth/ (a sign-in), node_modules/ and the
 *  engine's cockpit caches were all committed into the person's repo. */
export function brainIgnoresAdopted() {
  try {
    const out = []; let keep = false;
    for (const line of readFileSync(LIST, 'utf8').split('\n')) {
      if (/^# --- /.test(line)) keep = /adopted brain, which tracks/.test(line);
      if (keep) continue;
      const t = line.replace(/#.*/, '').trim();
      if (t) out.push(t);
    }
    return out;
  } catch { return brainRequired(); }
}

/** The set a writer repairs and untracks for THIS brain. An adopted brain
 *  (spec 2026-10-17) tracks its own .claude/ and cockpit/ on purpose, so it gets
 *  everything else; every other brain gets the full list, as before. */
export function brainIgnoresFor(stateDir) {
  return isAdopted(stateDir) ? brainIgnoresAdopted() : brainIgnores();
}
