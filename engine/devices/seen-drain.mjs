#!/usr/bin/env node
// seen-drain.mjs — stamp last-seen onto the device roster from the host's
// sighting log. The one purely-local duty that survived enrol-sync.mjs when the
// central directory was deleted (self-host strip, 2026-09-01): everything else
// that job did — /box-register, the /mineral-register ownership mirror, staged
// enrolments, web revokes, web grants — was a client of the dead service and
// went with it. Device add/remove is local now (the wizard writes
// /state/ssh/member/authorized_keys over SSH); recency still matters, and this
// is what keeps it true.
//
// LAST SEEN (2026-08-13, unchanged mechanics). The roster has carried a
// last_seen column since 2026-08-04 and nothing ever wrote it. The host's
// AuthorizedKeysCommand appends one line per offered key to
// /state/devices/seen.log. It cannot write the roster itself, and should not:
// that YAML is roster.mjs's to own, inside the container. So this drains the
// log and stamps the rows, keeping the host a dumb appender.
//
// Only boxes whose cloud-init template carries the hook report; a box stamped
// before its tier's template gained it never writes the log, this no-ops for
// it, and its rows stay honestly blank rather than claiming a sighting that
// never happened. (History: pebbles only gained the hook 2026-08-20; rocks
// 2026-08-13. provisioning/managed/last-seen-hook.test.mjs pins the chain.)
//
// Run: node seen-drain.mjs [stateDir]   (scheduler: odd minutes, guarded)
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampLastSeen } from './roster.mjs';

export function seenDrain({
  stateDir = process.argv[2] || process.env.AIOS_STATE_DIR || '/state',
  log = (m) => console.log(`[seen-drain] ${m}`),
} = {}) {
  try {
    const seenPath = join(stateDir, 'devices', 'seen.log');
    if (!existsSync(seenPath)) return { stamped: 0 };
    const raw = readFileSync(seenPath, 'utf8');
    // last write wins per fingerprint: the file is append-only and we only
    // care about the most recent sighting of each key
    const latest = new Map();
    for (const line of raw.split('\n')) {
      const [at, fp] = line.trim().split(/\s+/);
      if (!at || !fp || !fp.startsWith('SHA256:')) continue;
      if (!latest.has(fp) || at > latest.get(fp)) latest.set(fp, at);
    }
    let stamped = 0;
    for (const [fp, at] of latest) { if (stampLastSeen(stateDir, fp, at)) stamped += 1; }
    // Truncated only after the stamps land, so a crash mid-loop re-reads them
    // next round rather than losing the sightings entirely.
    writeFileSync(seenPath, '');
    if (stamped) log(`stamped last-seen on ${stamped} device${stamped === 1 ? '' : 's'}`);
    return { stamped };
  } catch (e) {
    log(`last-seen drain skipped (${String(e && e.message || e).slice(0, 60)})`);
    return { stamped: 0, error: String(e && e.message || e) };
  }
}

// CLI entry (the scheduler's call). import.meta.url check keeps tests import-safe.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  seenDrain({});
}
