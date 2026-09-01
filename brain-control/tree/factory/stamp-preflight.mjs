// stamp-preflight.mjs · everything a stamp needs, checked in ONE pass.
//
// WHY. Stamping a pebble needs four credentials and a checkout, and until now
// each was discovered separately, deep inside a script, one failed run at a
// time: fix the GitHub owner, run again, learn the Hetzner token is missing,
// run again. Every one of those refusals was raw shell aimed at whoever wrote
// the script, not at the rock owner reading it in the app.
//
// This reports the whole set at once, in words, and says what fixes each gap.
// It is a READ. It creates nothing, spends nothing, and is safe to run from a
// status panel (see the `factory-status` verb in the app).
//
// The GitHub leg additionally VERIFIES that the resolved token can act for the
// resolved owner. Without that, a wrong pair is discovered by a 403 in the
// middle of a stamp, after a VM exists and is billing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv, resolveOrgGitHub, verifyOwner, CONNECT_STEP } from './org-github.mjs';

// App first, terminal second. The Crads-AI app has had a Connect GitHub button
// on the Pebbles page since 2026-08-10; the command is the fallback for anyone
// who prefers it or is not at the app. Naming only the command was how a shell
// instruction became the product's answer to its most common first failure.
const CONNECT_FIX = `press Connect GitHub on the Pebbles page of the Crads-AI app `
  + `(or run  ${CONNECT_STEP}  in this rock's Terminal)`;
const STAGE_FIX = 'ask whoever set up this rock to stage its provisioning tokens '
  + '(technical: /state/secrets/provisioning.env.local on the box)';

/**
 * @returns {{armed:boolean, checks:Array<{id,ok,title,detail,fix}>}}
 */
export function preflight({ env = process.env, brainRoot = '', aiosDir = '' } = {}) {
  const AIOS = aiosDir || env.AIOS_DIR || '/app';
  // The staged provisioning env is normally sourced into the environment before
  // we run, but the status panel calls this cold. Read the file too, so a status
  // read never reports a gap that a stamp would not actually hit.
  let staged = {};
  for (const p of [join(AIOS, 'provisioning', 'managed', '.env.local'), '/state/secrets/provisioning.env.local']) {
    try { if (existsSync(p)) staged = { ...parseDotenv(readFileSync(p, 'utf8')), ...staged }; } catch { /* unreadable is absent */ }
  }
  const val = (name) => String(env[name] ?? staged[name] ?? '').trim();
  const checks = [];

  // ---- 1. the org's GitHub -------------------------------------------------
  const gh = resolveOrgGitHub({ env: { ...staged, ...env }, brainRoot });
  if (!gh.ok) {
    checks.push({
      id: 'github', ok: false, title: 'GitHub account',
      detail: 'No GitHub account is connected, so the private repositories a pebble needs cannot be created.',
      fix: CONNECT_FIX,
    });
  } else {
    const v = verifyOwner({ owner: gh.owner, token: gh.token, env });
    checks.push({
      id: 'github', ok: v.ok, title: 'GitHub account',
      detail: v.ok ? `Repositories will be created under "${gh.owner}" (from ${gh.from}; ${v.reason}).` : v.reason,
      fix: v.ok ? '' : CONNECT_FIX,
    });
  }

  // ---- 2 and 3. the metal and the address ---------------------------------
  //
  // A CUSTOMER ROCK NEVER HOLDS THESE, AND ASKING FOR THEM IS THE BUG (finding 69).
  //
  // Sam's brokered ruling: "when a rock stamps a pebble, it just asks Crads-AI to
  // build the pebble for the rock". A customer rock has no Hetzner or Cloudflare
  // credential and by that ruling never will; cockpit's fulfil-arrivals injects
  // metal for the one command and takes it away again.
  //
  // These two checks used to FAIL without them and advise "ask whoever set up
  // this rock to stage its provisioning tokens". That is the exact dead end the
  // ruling exists to prevent, printed as official advice, and an owner who
  // follows it either gives up or succeeds — which is worse, because it ends with
  // platform credentials pasted onto a customer box. I did precisely that while
  // testing on 2026-08-12, which is how it came to light.
  //
  // So absence is now NORMAL and non-blocking, and the preflight says who supplies
  // it. Presence is still reported, because the platform's own factory runs this
  // same file with the tokens injected and an operator should see which mode they
  // are in. Nothing here gates a brokered stamp any more.
  const cfDom = val('CF_TUNNEL_ROOT_DOMAIN');
  checks.push(val('HCLOUD_TOKEN')
    ? { id: 'server', ok: true, title: 'Server provider', detail: 'A Hetzner token is staged, so this box can create machines itself.', fix: '' }
    : { id: 'server', ok: true, title: 'Server provider', detail: 'Crads-AI supplies the machine when you create a pebble. Nothing for you to stage.', fix: '' });

  checks.push(cfDom
    ? { id: 'address', ok: true, title: 'Secure address', detail: `New pebbles get an address under ${cfDom}.`, fix: '' }
    : { id: 'address', ok: true, title: 'Secure address', detail: 'Crads-AI gives each new pebble its address. Nothing for you to stage.', fix: '' });

  // ---- 4. the software a pebble runs --------------------------------------
  checks.push(val('PEBBLE_IMAGE')
    ? { id: 'image', ok: true, title: 'Pebble software', detail: `New pebbles run ${val('PEBBLE_IMAGE')}.`, fix: '' }
    : { id: 'image', ok: false, title: 'Pebble software', detail: 'The pebble software image is not set, so there is nothing to install on a new box.', fix: STAGE_FIX });

  // ---- 5. the provisioning this rock wraps --------------------------------
  // provision-PEBBLE.sh. The 2026-08-10 'client becomes pebble' pass renamed the
  // file in ai-os and left this check, the call site in stamp-pebble.sh, and the
  // fixture in tests/ pointing at the old name. So every rock reported "This box
  // is missing the provisioning that creates member machines" and was told to
  // restart to pick up newer software, which could never help: the file is not
  // coming back. Found 2026-08-12 on a rock where the file was demonstrably
  // present. The test stayed green because its fixture wrote the old name too.
  const provisioner = join(AIOS, 'provisioning', 'managed', 'provision-pebble.sh');
  checks.push(existsSync(provisioner)
    ? { id: 'provisioning', ok: true, title: 'Provisioning', detail: 'The provisioning this rock drives is present on the box.', fix: '' }
    : {
      id: 'provisioning', ok: false, title: 'Provisioning',
      detail: 'This box is missing the provisioning that creates member machines.',
      fix: 'restart this rock to pick up the latest published software; if it persists, tell Crads-AI support',
    });

  return { armed: checks.every((c) => c.ok), checks };
}

/** All failures at once, as one human message. Empty string when armed. */
export function report(result) {
  const bad = result.checks.filter((c) => !c.ok);
  if (!bad.length) return '';
  const head = bad.length === 1
    ? 'This rock cannot create a member box yet. One thing is missing:'
    : `This rock cannot create a member box yet. ${bad.length} things are missing:`;
  const body = bad.map((c) => `  ${c.title}: ${c.detail}\n    To fix: ${c.fix}`).join('\n\n');
  return `${head}\n\n${body}\n\nNothing has been created and no member has been changed.`;
}

if (process.argv[1] && process.argv[1].endsWith('stamp-preflight.mjs')) {
  const brainRoot = process.env.AIOS_BRAIN_ROOT || process.env.BR || process.cwd();
  const r = preflight({ brainRoot });
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  }
  if (!r.armed) { process.stderr.write(report(r) + '\n'); process.exit(4); }
  process.stdout.write('factory ready\n');
}
