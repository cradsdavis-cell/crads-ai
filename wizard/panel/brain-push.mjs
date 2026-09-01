// brain-push.mjs — opportunistic sync for member-OWNED brains (D58 P3.5). Once a
// member has run own-brain, their box pushes whenever their app opens: no cadence
// dependency, no image change, and a box that is never opened simply syncs next
// time it is. Fail-silent by design; owning is P3.2's job, syncing is best-effort.
export async function pushOwnedBrains({ targets = [], bridge, log = () => {} } = {}) {
  const pushed = [], failed = [];
  for (const t of targets) {
    if (!t || t.kind !== 'member') continue;
    try {
      const probe = await bridge(t.host, 'if [ -d /state/brain ]; then BR=/state/brain; else BR=/state; fi; cd "$BR" && git remote get-url origin 2>/dev/null');
      if (probe.code !== 0 || !String(probe.stdout || '').trim()) continue;   // not owned yet: not our business
      // DRIVE THE GUARDED PUSH, DO NOT OPEN-CODE A FOURTH ONE (2026-08-20 audit).
      // This was a blind `git add -A` plus push, unattended, on every app open,
      // with no protective-.gitignore check and no untrack pass. It was the
      // fourth path pushing this same tree and the most frequently fired of
      // them, and it carried none of the protections engine/brain-push.sh
      // applies: on a box whose ignore set predates the canonical list, that
      // meant staging and publishing <brainRoot>/.env, which holds
      // ORG_PULL_TOKEN. brain-push.sh refuses on an unprotected tree, sheds
      // anything already tracked, and writes its own log, so calling it gets
      // the guard, the untrack pass and the honesty for free.
      const push = await bridge(t.host, 'bash /app/engine/brain-push.sh 2>&1');
      if (push.code === 0) { pushed.push(t.host); log(`brain synced: ${t.host}`); }
      else { failed.push({ host: t.host, reason: (push.stderr || push.stdout || '').trim() }); log(`brain sync skipped (${t.host}): ${(push.stderr || push.stdout || '').trim()}`); }
    } catch (e) { failed.push({ host: t.host, reason: String(e && e.message || e) }); }
  }
  return { pushed, failed };
}
