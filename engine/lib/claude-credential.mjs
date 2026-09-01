// claude-credential.mjs: the ONE reader of a box's Claude sign-in (2026-08-20 audit).
//
// Three files asked this question and each asked it its own way, which is how
// they drifted:
//
//   engine/heartbeat.mjs             existsSync(<box>/.claude-auth/.credentials.json)
//                                    and pushed the answer up as `auth_ok`
//   engine/ops/box-account.mjs       readFileSync(...).trim().length > 0
//   engine/cockpit/box-cockpit.mjs   !!readFileSync(...)
//
// So two of the three counted a ZERO-BYTE credential file as a sign-in and one
// did not, and all three named their answer as though it were about auth.
//
// IT IS NOT ABOUT AUTH. A file on disk is not a live grant. Revoking a grant, or
// letting it reach the point where a refresh no longer works, changes nothing
// about that file. A mineral that could not reach Claude at all therefore
// reported auth_ok:true, its own Health card showed a green sign-in row, and the
// rock's stall board rendered it as "active, N skills running".
//
// WHAT A BOX CAN HONESTLY KNOW about its own sign-in, with no network call, is
// two things, and this module returns exactly those two:
//
//   present   a non-empty credential file is here, so somebody signed in on this
//             box at some point
//   account   which account it names (.claude-auth/.claude.json)
//
// AND ONE THING IT CANNOT KNOW: whether that grant is still honoured.
//
// The obvious-looking third field, the expiry the credential states for itself,
// is deliberately NOT here, because it does not mean what it looks like it
// means. Measured on a working machine on 2026-08-20: claudeAiOauth.expiresAt
// read 2026-08-14T07:50:29Z, five days and eighteen hours in the past, while
// Claude Code was running on that machine at that moment. Claude Code renews in
// process and does not always rewrite the file, so a past expiry is the ordinary
// state of a perfectly healthy box. A health check built on it would have lit up
// most of the fleet: that is the same invented-check failure this module exists
// to stop, wearing the other face.
//
// The honest evidence that a sign-in still WORKS is not on this side at all, it
// is work that keeps finishing. engine/heartbeat.mjs carries that as
// skill_ok_runs, taken from the kernel's own run ledger.
//
// NOTHING SECRET LEAVES THIS MODULE. The credential file holds live tokens. This
// reader never parses them, never returns them and never logs them: it takes the
// file's length and, from a different file, an email address.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CREDENTIAL_REL = ['.claude-auth', '.credentials.json'];
export const ACCOUNT_REL = ['.claude-auth', '.claude.json'];

/**
 * @param {string} boxDir the mineral's state dir (a box root, not a brain root)
 * @returns {{present: boolean, account: string|null}}
 */
export function readClaudeCredential(boxDir) {
  const dir = boxDir || '.';
  // Presence is a LENGTH test, not an existsSync. A zero-byte credential file is
  // what a half-written sign-in leaves behind, and treating that as signed in is
  // exactly where box-account and the heartbeat used to disagree about one box.
  let present = false;
  try { present = readFileSync(path.join(dir, ...CREDENTIAL_REL), 'utf8').trim().length > 0; } catch { present = false; }
  if (!present) return { present: false, account: null };
  // The account name is a SEPARATE file and a separate failure: a mineral can
  // hold a credential whose .claude.json is missing or unparseable, and the
  // honest answer there is "signed in, account unknown", which is what the
  // callers already print. Never let that turn presence into absence.
  let account = null;
  try {
    const j = JSON.parse(readFileSync(path.join(dir, ...ACCOUNT_REL), 'utf8'));
    account = (j && j.oauthAccount && j.oauthAccount.emailAddress) || null;
  } catch { account = null; }
  return { present: true, account };
}


