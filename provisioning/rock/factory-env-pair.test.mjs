// factory-env-pair.test.mjs — a rock is staged CONFIGURATION ONLY, never a
// hosting credential. Run:
//   node --test provisioning/rock/factory-env-pair.test.mjs
//
// History. The 2026-08-04 brokered ruling took the platform's tokens off
// CUSTOMER rocks; an AIOS_STAGE_PLATFORM_TOKENS=1 escape hatch kept staging the
// operator's live HCLOUD + CF + GITHUB tokens onto platform-owned rocks. The
// self-host strip (2026-09-01) removed the hatch with the hosted platform
// itself: a rock is a community hub with no metal, it must never receive a
// Hetzner or Cloudflare token, and therefore can never create a pebble. This
// file extracts the staging block and RUNS it, because the contract is about
// what the block emits, not what it looks like. Nothing here reaches an API:
// the block is pure string assembly and every input is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'provision-rock.sh'), 'utf8');

/** The staging block, from the GH_OWNER assignment to the FACTORY_ENV_B64 write. */
function stagingBlock() {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => /^GH_OWNER="\$\{REPO_PATH%%\/\*\}"$/.test(l));
  assert.ok(start > -1, 'the GH_OWNER assignment moved; update this test with it');
  const end = lines.findIndex((l, i) => i > start && /\| base64 -w0\)"$/.test(l));
  assert.ok(end > start, 'no FACTORY_ENV_B64 assembly found after GH_OWNER');
  return lines.slice(start, end + 1).join('\n');
}

/** Run it with stubs and return the staged env as a parsed object. */
function stage({ seed, platformTokens = false }) {
  const dir = tmpDir('fep-');
  const script = [
    'set -euo pipefail',
    'say(){ :; }',                     // the block narrates; the narration is not under test
    'c_dim=""; c_off=""',
    'REPO_PATH="platform-owner/brain-template"',
    `BRAIN_SEED="${seed}"`,
    // The removed escape hatch: exporting it must change NOTHING now.
    platformTokens ? 'AIOS_STAGE_PLATFORM_TOKENS=1' : 'AIOS_STAGE_PLATFORM_TOKENS=""',
    'HCLOUD_TOKEN="hc"; CF_API_TOKEN="cf"; CF_ACCOUNT_ID="acct"; ROOT_DOMAIN="example.com"',
    'CF_ZONE_NAME="example.com"; GITHUB_TOKEN="platform-token"; OPERATOR_SSH_KEY_NAME=""',
    'IMAGE="ghcr.io/x/crads-rock:v2"',
    'PEBBLE_IMAGE="ghcr.io/x/crads-pebble:v2"',
    stagingBlock(),
    'printf %s "$FACTORY_ENV_B64" | base64 -d',
  ].join('\n');
  const f = join(dir, 'stage.sh');
  writeFileSync(f, script);
  const out = execFileSync('bash', [f], { encoding: 'utf8' });
  return Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}

test('THE RULING: no rock is ever staged a hosting credential', () => {
  for (const seed of ['template', 'repo']) {
    const env = stage({ seed });
    assert.equal('HCLOUD_TOKEN' in env, false, 'a rock must never receive a Hetzner token: with one it could create pebbles');
    assert.equal('CF_API_TOKEN' in env, false, 'nor a Cloudflare token');
    assert.equal('GITHUB_TOKEN' in env, false, 'nor the platform PAT');
    assert.equal(env.PEBBLE_IMAGE, 'ghcr.io/x/crads-pebble:v2', 'what it DOES get is configuration');
  }
});

test('the removed AIOS_STAGE_PLATFORM_TOKENS hatch is inert if somebody exports it', () => {
  const env = stage({ seed: 'template', platformTokens: true });
  assert.equal('HCLOUD_TOKEN' in env, false, 'the escape hatch is gone, not merely off by default');
  assert.equal('CF_API_TOKEN' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.doesNotMatch(SRC, /AIOS_STAGE_PLATFORM_TOKENS:-/, 'and nothing in the script reads the flag any more');
});

test('template mode blanks GH_OWNER: the platform is never the default home for an org\'s artefacts', () => {
  const env = stage({ seed: 'template' });
  assert.equal(env.GH_OWNER, '');
});

test('a repo-seeded rock keeps the owner its brain repo names', () => {
  const env = stage({ seed: 'repo' });
  assert.equal(env.GH_OWNER, 'platform-owner', 'repo mode names the org\'s own repo, so its owner is theirs');
});

// ---------------------------------------------------------------------------
// The image pull token, held to the same contract (2026-08-20 audit, hardened
// by the self-host strip): the platform PAT must never ride along as the GHCR
// token. A deliberately staged scoped read token is the only thing accepted.

/** The GHCR gate, extracted and run the same way the staging block is. */
function ghcrToken({ staged }) {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => /^GHCR_PULL="\$\{GHCR_PULL_TOKEN:-\}"$/.test(l));
  assert.ok(start > -1, 'the GHCR gate moved; update this test with it');
  const block = lines.slice(start, start + 2).join('\n');
  const script = [
    'set -euo pipefail',
    'say(){ :; }', 'c_dim=""; c_off=""',
    'GITHUB_TOKEN="platform-token"',
    staged ? 'GHCR_PULL_TOKEN="scoped-read-token"' : 'GHCR_PULL_TOKEN=""',
    block,
    'printf %s "$GHCR_PULL"',
  ].join('\n');
  const dir = tmpDir('ghcr-');
  const f = join(dir, 'ghcr.sh');
  writeFileSync(f, script);
  return execFileSync('bash', [f], { encoding: 'utf8' });
}

test('THE RULING HOLDS FOR THE IMAGE TOKEN TOO: a rock carries none by default', () => {
  assert.equal(ghcrToken({ staged: false }), '',
    'the platform PAT must not ride along as the image pull token; the product images are public');
});

test('a deliberately staged scoped token is used, and only that', () => {
  assert.equal(ghcrToken({ staged: true }), 'scoped-read-token');
  const code = SRC.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // the comment may quote the old bug
  assert.doesNotMatch(code, /GHCR_PULL_TOKEN:-\$GITHUB_TOKEN/, 'the PAT fallback stays dead');
});

test('the template clone URL never embeds the platform PAT either', () => {
  const m = SRC.match(/BRAIN_REPO="https:\/\/x-access-token:\$\{([^}]*)\}@github\.com/);
  assert.ok(m, 'the template-mode clone URL is still built here');
  assert.doesNotMatch(m[1], /GITHUB_TOKEN/,
    'a URL carrying the platform PAT lands in /var/lib/cloud on customer metal and stays there');
  assert.match(SRC, /BRAIN_REPO="https:\/\/github\.com\/\$REPO_PATH\.git"/,
    'with no token staged it clones the public template anonymously');
});
