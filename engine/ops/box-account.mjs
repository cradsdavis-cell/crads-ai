#!/usr/bin/env node
// box-account.mjs: identity guard for a client box's Claude sign-in (reusable, every client).
// Answers WHICH ACCOUNT a box holds a credential for, and CRITICALLY whether that account is the
// OPERATOR (the cross-client identity leak that already bit once: a box silently signed in as the
// operator looks fine to a presence-only check). A file-presence check cannot catch its own bug
// class; naming the account can.
//
// WHAT "OK" MEANS HERE, EXACTLY (2026-08-20 audit). It means a non-empty credential file is on
// this box and it names a non-operator account. It does NOT mean the grant still works: revoking
// it leaves the file untouched, and nothing on a box can tell the difference without a network
// call. The token stays `OK:` because engine/box-up.sh and provisioning/rock/boot-rock.sh both
// parse it with `case "$ACCT" in OK:*)` and take the email with `${ACCT#OK:}`, and that is a
// machine contract, not a report to a human. The honest sentence a human reads is the one in
// engine/cockpit/box-cockpit.mjs, and the honest evidence that the sign-in still works is
// skill_ok_runs in engine/heartbeat.mjs: runs that keep finishing.
//
// ONE LINE OF STDOUT, ALWAYS. box-up.sh's own comment records the day a second line turned ACCT
// into two lines and produced the message "OPERATOR (<operator address> NOT-SIGNED-IN)". Do not
// add one.
//
// NO BUILT-IN OPERATOR (2026-10-13). This defaulted to one person's own address, which shipped
// that address in every public image and, on a self-hosted mineral, has nothing to guard: the
// person who owns the box IS the right account. The check now runs only when the old rock
// provisioning sets AIOS_OPERATOR_EMAIL.
//
//   node box-account.mjs <boxDir>
//   stdout: NOT-SIGNED-IN | OK:<email> | OPERATOR:<email> | UNKNOWN
//   exit:   0 (ok / not-signed-in)        3 (OPERATOR account, block)
import { readClaudeCredential } from '../lib/claude-credential.mjs';

const box = process.argv[2] || '.';
const OPERATOR = String(process.env.AIOS_OPERATOR_EMAIL || '').trim().toLowerCase();
// One reader for all three callers of this question (see the module header): this file used to
// count a non-empty file while engine/heartbeat.mjs counted mere existence, so the two could
// disagree about the same box.
const { present, account } = readClaudeCredential(box);
if (!present) { console.log('NOT-SIGNED-IN'); process.exit(0); }
if (OPERATOR && account && account.toLowerCase() === OPERATOR) { console.log('OPERATOR:' + account); process.exit(3); }
console.log(account ? 'OK:' + account : 'UNKNOWN'); process.exit(0);


