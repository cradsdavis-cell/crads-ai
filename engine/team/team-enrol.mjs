#!/usr/bin/env node
// team-enrol.mjs: put a box into a team (Crads for teams, stage 1, 2026-10-10).
//
// A team is one company brain plus one box per person, every box in the
// COMPANY's own cloud account and every repo in the company's own GitHub. The
// owner's desktop app drives this over SSH; nothing central exists.
//
// Write isolation is by repository, not by branch. GitHub deploy keys cannot be
// limited to a branch on a free private repo, so a staff box that could push to
// the company repo could rewrite anything in it. Instead:
//   - company repo  <company>-team-brain : staff boxes hold a READ-ONLY deploy
//                                          key; the hub box holds the only WRITE key.
//   - per person    <company>-from-<slug>: that person's box holds the only WRITE
//                                          key; the hub holds a READ key.
// The hub copies ONLY members/<slug>/ out of each person's repo (team-hub.mjs), so
// whatever else a box pushes to its own repo never reaches anyone.
//
//   node team-enrol.mjs keys  <state-dir> <name> [<name>...]   -> {"<name>": "<pubkey>"}
//   node team-enrol.mjs enrol <state-dir> '<config json>'      -> clones, config, CLAUDE.md, personal/
//
// Config (written to <state>/org/config.json):
//   { slug, role: "member"|"hub", company, person?,
//     brain:  { remote, key },                       // everyone
//     outbox: { remote, key },                       // member only
//     members:[{ slug, remote, key }] }              // hub only
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const KEY_NAME_RE = /^(brain|outbox|from-[a-z0-9][a-z0-9-]{0,30}[a-z0-9])$/;
export const CLAUDE_MARK_START = '<!-- team-brain:start -->';
export const CLAUDE_MARK_END = '<!-- team-brain:end -->';

export const keyDir = (stateDir) => path.join(stateDir, 'secrets', 'team');

export const sshCommandFor = (key) => `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;

// Mint (or reuse) one ed25519 keypair per name ON THE BOX. The private half never
// leaves it; the app reads back only the public half to register as a deploy key.
export function ensureKeys(stateDir, names, { keygen = defaultKeygen } = {}) {
  const dir = keyDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {};
  for (const name of names) {
    if (!KEY_NAME_RE.test(name)) throw new Error(`bad key name: ${name}`);
    const priv = path.join(dir, name);
    if (!existsSync(priv)) keygen(priv, `team-${name}`);
    chmodSync(priv, 0o600);
    out[name] = readFileSync(`${priv}.pub`, 'utf8').trim();
  }
  return out;
}

function defaultKeygen(priv, comment) {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', priv], { stdio: 'pipe' });
}

export function validateConfig(cfg) {
  const err = (m) => { throw new Error(`team config: ${m}`); };
  if (!cfg || typeof cfg !== 'object') err('not an object');
  if (!SLUG_RE.test(String(cfg.slug || ''))) err('slug must be 2-32 lowercase letters, digits or hyphens');
  if (!SLUG_RE.test(String(cfg.company || ''))) err('company must be 2-32 lowercase letters, digits or hyphens');
  if (cfg.role !== 'member' && cfg.role !== 'hub') err('role must be member or hub');
  if (!cfg.brain || !cfg.brain.remote || !cfg.brain.key) err('brain.remote and brain.key are required');
  if (cfg.role === 'member' && (!cfg.outbox || !cfg.outbox.remote || !cfg.outbox.key)) err('a member needs outbox.remote and outbox.key');
  if (cfg.role === 'hub') {
    if (!Array.isArray(cfg.members)) err('a hub needs a members list');
    for (const m of cfg.members) {
      if (!SLUG_RE.test(String(m.slug || '')) || !m.remote || !m.key) err(`bad member entry ${JSON.stringify(m)}`);
    }
  }
  return cfg;
}

const git = (args, opts = {}) => execFileSync('git', ['-c', 'user.name=box', '-c', 'user.email=box@local', ...args], { stdio: 'pipe', ...opts });

// Clone once, then (every run) pin the remote and the key in the repo's own config,
// so the scheduler's plain `git pull` / `git push` use the right key with no env.
export function ensureClone(dir, remote, key) {
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    git(['clone', '-q', remote, dir], { env: { ...process.env, GIT_SSH_COMMAND: sshCommandFor(key) } });
  }
  git(['-C', dir, 'remote', 'set-url', 'origin', remote]);
  git(['-C', dir, 'config', 'core.sshCommand', sshCommandFor(key)]);
}

const PERSONAL_README = `# Personal

Nothing in this folder, and no page with \`enclave: true\` in its frontmatter, is
ever published to the company brain or read by the company agent. It stays on
this server.

Plainly: your company owns this server. This folder is private from the company
brain and from your colleagues' assistants. It is not secret from whoever
administers the server. Use it for work in progress (drafts, half-formed
thoughts, notes you would rather not broadcast), not for your private life.
`;

export function claudeSection(cfg) {
  const lines = [
    CLAUDE_MARK_START,
    `## Company brain (${cfg.company}): read this first`,
    '',
    `This box belongs to the ${cfg.company} team. The company brain is a read-only copy at`,
    '`org/brain/`, refreshed every hour. Read it before your own wiki whenever a question',
    'touches the company, its clients, its processes or what a colleague knows:',
    '',
    '- `company/`: who we are, how we sound, policies and prices. Treat these as the rules.',
    '- `clients/`, `processes/`: shared knowledge, kept by the team.',
    '- `entities/`: one page per client or project, merged from what each person published.',
    '  Sections are per person; where they disagree, say so and show both sources.',
    '- `digest/`: the daily digest, `digest/week-<year>-W<nn>.md` (the week so far) and, if the',
    '  team shares an inbox, `digest/inbox-<date>.md` (one line per new message, read only).',
    '',
    'Every published claim carries a `source:` line naming the person and page it came from.',
    'Cite it. If only one person has published on something, say that.',
    '',
    'You cannot change the company brain from here. To change a policy, price, process or',
    'shared skill, write a proposal and the owner approves it.',
  ];
  if (cfg.role === 'member') {
    // Found in the live demo (2026-10-10): without this the assistant told Jess to
    // "check with Jess and Tom", not knowing whose assistant it was.
    lines.push('', `This is ${cfg.person || cfg.slug}'s assistant. In the company brain their pages are \`members/${cfg.slug}/\` and their claims are sourced \`${cfg.slug}/...\`; everyone else's are colleagues'.`);
    lines.push('', 'Personal: `wiki/personal/` and pages with `enclave: true` never leave this box.',
      'Everything else in `wiki/` is published to the company brain as facts, nightly.');
  } else {
    lines.push('', 'This is the company agent\'s box. It is the only writer of the company brain.');
  }
  lines.push(CLAUDE_MARK_END);
  return lines.join('\n');
}

// Replace the marked block in place (re-enrol updates it), or append it.
export function upsertClaudeSection(file, section) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  const a = text.indexOf(CLAUDE_MARK_START);
  const b = text.indexOf(CLAUDE_MARK_END);
  if (a !== -1 && b > a) {
    text = text.slice(0, a) + section + text.slice(b + CLAUDE_MARK_END.length);
  } else {
    text = (text.trimEnd() ? `${text.trimEnd()}\n\n` : '') + `${section}\n`;
  }
  writeFileSync(file, text);
}

export function enrol(stateDir, cfgIn, { clone = ensureClone } = {}) {
  const cfg = validateConfig(cfgIn);
  const orgDir = path.join(stateDir, 'org');
  mkdirSync(orgDir, { recursive: true });
  clone(path.join(orgDir, 'brain'), cfg.brain.remote, cfg.brain.key);
  if (cfg.role === 'member') {
    clone(path.join(orgDir, 'outbox'), cfg.outbox.remote, cfg.outbox.key);
    mkdirSync(path.join(stateDir, 'wiki', 'personal'), { recursive: true });
    const readme = path.join(stateDir, 'wiki', 'personal', 'README.md');
    if (!existsSync(readme)) writeFileSync(readme, PERSONAL_README);
  } else {
    for (const m of cfg.members) clone(path.join(orgDir, 'members', m.slug), m.remote, m.key);
  }
  writeFileSync(path.join(orgDir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  upsertClaudeSection(path.join(stateDir, 'CLAUDE.md'), claudeSection(cfg));
  return { ok: true, slug: cfg.slug, role: cfg.role };
}

if (isMain(import.meta.url)) {
  const [verb, stateDir, ...rest] = process.argv.slice(2);
  try {
    if (verb === 'keys' && stateDir && rest.length) {
      process.stdout.write(`TEAM_KEYS ${JSON.stringify(ensureKeys(stateDir, rest))}\n`);
    } else if (verb === 'enrol' && stateDir && rest[0]) {
      const r = enrol(stateDir, JSON.parse(rest[0]));
      process.stdout.write(`TEAM_ENROLLED ${JSON.stringify(r)}\n`);
    } else {
      console.error("usage: team-enrol.mjs keys <state> <name>... | enrol <state> '<config json>'");
      process.exit(64);
    }
  } catch (e) {
    console.error(String((e && e.stderr && e.stderr.toString()) || (e && e.message) || e).trim());
    process.exit(1);
  }
}
