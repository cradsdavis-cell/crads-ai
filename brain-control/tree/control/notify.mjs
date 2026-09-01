#!/usr/bin/env node
// notify.mjs — how a rock tells its admins something happened.
//
//   node control/notify.mjs "<one line>"
//
// Every reconciler on this box already calls this hook (invite, join, leave,
// permission, ask-answers, requests, re-anchor). Until 2026-08-09 the file did
// not exist in the template, so the hook was a no-op on every rock ever stamped
// and each of those events was silent unless an org wrote their own.
//
// That was survivable while a human approved every device by hand — the ceremony
// WAS the notification. Sam's ruling that day killed the ceremony (the audit
// showed it was inert) and replaced it with "no human: the staged key installs
// itself", with one condition attached: **it appears in People, plus a
// notification**. A join that nobody is told about is exactly what that ruling
// refused, so this file is now part of the template.
//
// It is deliberately dumb and dependency-free. Two sinks, both best-effort:
//   FILE  control/notices.json — always written, newest first, bounded. This is
//         the sink that cannot fail, and it is what the panel reads, so the
//         guarantee holds on a box with no channel configured at all.
//   PUSH  a webhook, if the org set one. NOTICE_WEBHOOK in the brain .env (or
//         the environment) gets a JSON POST. Slack and Discord both accept
//         {text}, so the common cases need no adapter.
//
// Never throws and never blocks: a reconciler that cannot deliver a notice must
// still finish its work, and every caller invokes this fire-and-forget.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const NOTICES = path.join(REPO, 'control', 'notices.json');
const KEEP = 200;

export async function notify(text, { repoRoot = REPO, fetcher = fetch, now = () => new Date() } = {}) {
  const line = String(text || '').trim().slice(0, 500);
  if (!line) return { written: false, pushed: false, why: 'empty notice' };
  const file = path.join(repoRoot, 'control', 'notices.json');

  let written = false;
  try {
    let list = [];
    try { list = JSON.parse(await readFile(file, 'utf8')); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.unshift({ at: now().toISOString(), text: line });
    await writeFile(file, JSON.stringify(list.slice(0, KEEP), null, 2));
    written = true;
  } catch { /* the push below is still worth attempting */ }

  let pushed = false;
  try {
    const envText = await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => '');
    const hook = process.env.NOTICE_WEBHOOK
      || (envText.match(/^NOTICE_WEBHOOK=(.+)$/m) || [])[1]?.trim();
    if (hook && /^https:\/\//.test(hook)) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetcher(hook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: line }), signal: ctrl.signal,
      });
      clearTimeout(t);
      pushed = !!(r && r.ok);
    }
  } catch { /* a dead webhook must never cost us the notice we already filed */ }

  return { written, pushed };
}

if (process.argv[1] && process.argv[1].endsWith('notify.mjs')) {
  const out = await notify(process.argv.slice(2).join(' '));
  console.log(`notify: ${out.written ? 'filed' : 'NOT filed'}${out.pushed ? ' + pushed' : ''}`);
}
