// team-routes.mjs: the door's "Set up a team" flow (Crads for teams, stage 1, 2026-10-10).
//
// The owner runs this once, on their own computer, with their own provider token
// and their own GitHub sign-in. It makes, in the owner's accounts:
//   - a private company brain repo        <company>-team-brain
//   - a private repo per person           <company>-from-<person>
//   - the company agent's server          <company>-agent
//   - one server per person               <company>-<person>
// then mints keys ON each box, registers them as deploy keys (staff: read the
// company brain, write their own repo; agent: write the company brain, read
// each person's repo), and enrols every box (engine/team/team-enrol.mjs).
//
// Custody: the provider token and the GitHub token live in this process for the
// life of the run and are never written anywhere. The persisted team file holds
// only names, ids and progress, so a crashed run resumes (tokens re-entered) and
// every step is idempotent.
//
//   POST /team/start   {company, token, provider?, location?, server_type?, people:[{name}]} -> {ok}
//   GET  /team/status  -> the run, minus tokens
//   GET  /team/teams   -> the teams this computer set up: [{company, owner, people:[{slug,name}]}]
//   POST /team/add     {company, token, people:[{name}]}        stage 3: more people, same run
//   POST /team/remove  {company, token, person, confirm}         stage 3: someone's leaving
//   POST /team/support {company, action: grant|revoke, scope: agent|all, hours?}  one support window for the team
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerOf, DEFAULT_PROVIDER, PROVIDERS } from '../provision/providers.mjs';
import { githubClient, companySkeleton } from '../provision/team-github.mjs';
import { startDeviceFlow } from './github-device-flow.mjs';
import { buildBox } from './build-box.mjs';
import { destroySelfHost } from '../provision/engine.mjs';
import { installMemberAccess, removeIdentityAccess } from './member-connect.mjs';
import { pinHostForUser, runSsh } from './ssh-bridge.mjs';
import { registerClaudeSshConfig, syncClaudeStartDir, claudeSettingsPath, OPEN_FOLDER_PROBE } from './claude-settings.mjs';
import { boxImage } from './provision-routes.mjs';

const COMPANY_RE = /^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/;   // short, so <company>-<person> fits a box name
const MAX_PEOPLE = 15;
const ENROL = '/app/engine/team/team-enrol.mjs';
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// "Jess Smith" -> "jess"; a second Jess becomes "jess-smith". Kept short so the
// server name <company>-<person> stays inside 32 characters.
export function personSlugs(people) {
  const clean = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const firsts = people.map((p) => clean(String(p.name || '').trim().split(/\s+/)[0]));
  return people.map((p, i) => {
    let s = firsts[i];
    if (!s || firsts.filter((f) => f === s).length > 1) s = clean(p.name);
    return s.slice(0, 11).replace(/-+$/, '');
  });
}

export function planTeam(company, people) {
  if (!COMPANY_RE.test(company)) throw new Error('the team name must be 2-20 lowercase letters, digits or hyphens');
  if (!Array.isArray(people) || people.length < 1) throw new Error('add at least one person');
  if (people.length > MAX_PEOPLE) throw new Error(`up to ${MAX_PEOPLE} people for now`);
  const slugs = personSlugs(people);
  if (slugs.some((s) => !s || s.length < 2)) throw new Error('every person needs a name of at least two letters');
  if (new Set(slugs).size !== slugs.length) throw new Error('two people would get the same box name; add surnames');
  if (slugs.includes('agent')) throw new Error('"agent" is the company agent\'s name; pick another name for that person');
  const boxes = [{ slug: `${company}-agent`, role: 'hub', person: null, name: 'Company agent' }]
    .concat(slugs.map((s, i) => ({ slug: `${company}-${s}`, role: 'member', person: s, name: String(people[i].name).trim() })));
  return {
    company,
    brainRepo: `${company}-team-brain`,
    boxes: boxes.map((b) => ({ ...b, alias: `${b.slug}-box`, repo: b.role === 'member' ? `${company}-from-${b.person}` : null })),
  };
}

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Stage 3: add people to a team that exists. Everyone already on it keeps their
// box name (re-running personSlugs over the whole list could rename an existing
// Jess to jess-smith the day a second Jess joins).
export function extendPlan(plan, people) {
  if (!Array.isArray(people) || !people.length) throw new Error('add at least one person');
  const members = plan.boxes.filter((b) => b.role === 'member');
  if (members.length + people.length > MAX_PEOPLE) throw new Error(`up to ${MAX_PEOPLE} people for now`);
  const taken = new Set(members.map((b) => b.person).concat('agent'));
  const added = [];
  for (const p of people) {
    const name = String(p.name || '').trim();
    let s = slugify(name.split(/\s+/)[0]).slice(0, 11).replace(/-+$/, '');
    if (!s || taken.has(s)) s = slugify(name).slice(0, 11).replace(/-+$/, '');
    if (!s || s.length < 2) throw new Error(`"${name}" needs a name of at least two letters`);
    if (taken.has(s)) throw new Error(`${name} would get the same box name as someone already on the team; add a surname or an initial`);
    taken.add(s);
    added.push({ slug: `${plan.company}-${s}`, role: 'member', person: s, name, alias: `${plan.company}-${s}-box`, repo: `${plan.company}-from-${s}` });
  }
  return { plan: { ...plan, boxes: plan.boxes.concat(added) }, added: added.map((b) => b.slug) };
}

// The config each box is enrolled with (engine/team/team-enrol.mjs validates it).
export function enrolConfig(plan, owner, box) {
  const remote = (repo) => `ssh://git@github.com/${owner}/${repo}.git`;
  const key = (name) => `/state/secrets/team/${name}`;
  const base = { slug: box.role === 'hub' ? 'hub' : box.person, company: plan.company, role: box.role, brain: { remote: remote(plan.brainRepo), key: key('brain') } };
  if (box.role === 'member') return { ...base, person: box.name, outbox: { remote: remote(box.repo), key: key('outbox') } };
  return { ...base, members: plan.boxes.filter((b) => b.role === 'member').map((b) => ({ slug: b.person, remote: remote(b.repo), key: key(`from-${b.person}`) })) };
}

// Which key goes on which repo, with what access. The heart of write isolation.
export function deployKeysFor(plan, box) {
  if (box.role === 'member') {
    return [
      { name: 'brain', repo: plan.brainRepo, readOnly: true },
      { name: 'outbox', repo: box.repo, readOnly: false },
    ];
  }
  return [{ name: 'brain', repo: plan.brainRepo, readOnly: false }]
    .concat(plan.boxes.filter((b) => b.role === 'member').map((b) => ({ name: `from-${b.person}`, repo: b.repo, readOnly: true })));
}

export function teamRoutes(opts = {}) {
  const sshDir = opts.sshDir || join(homedir(), '.ssh');
  const makeClient = opts.makeClient || ((token, provider) => providerOf(provider).makeClient(token));
  const github = opts.github || ((token) => githubClient(token));
  const deviceFlow = opts.deviceFlow || (() => startDeviceFlow());
  const exec = opts.exec || ((alias, cmd) => runSsh(alias, cmd, { hardTimeoutMs: 300000 }));
  // Someone's leaving: where their personal/ folder lands on THIS computer, how
  // their box is forgotten here, and how their server is deleted.
  const exportDir = opts.exportDir || join(homedir(), 'Crads-AI', 'team-exports');
  const forget = opts.forget || ((alias) => removeIdentityAccess(alias, sshDir));
  const destroy = opts.destroy || destroySelfHost;
  const deps = {
    install: opts.install || installMemberAccess,
    pin: opts.pin || pinHostForUser,
    probe: opts.probe || ((alias) => runSsh(alias, 'echo chain-ok')),
    register: opts.register || registerClaudeSshConfig,
    syncStartDir: opts.syncStartDir || syncClaudeStartDir,
    openFolder: opts.openFolder || ((alias) => runSsh(alias, OPEN_FOLDER_PROBE)),
    settingsPath: opts.settingsPath || claudeSettingsPath(),
    makeClient, sshDir,
    sleep: opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    bootTimeoutMs: opts.bootTimeoutMs ?? 15 * 60_000,
    bootPollMs: opts.bootPollMs ?? 15_000,
    ...(opts.files ? { files: opts.files } : {}),
    ...((opts.image ?? boxImage()) ? { image: opts.image ?? boxImage() } : {}),
  };

  const teamPath = (company) => join(sshDir, `${company}-team.json`);
  const loadTeam = (company) => { try { return JSON.parse(readFileSync(teamPath(company), 'utf8')); } catch { return null; } };
  const saveTeam = () => {
    if (!run) return;
    mkdirSync(sshDir, { recursive: true });
    const { token, ghToken, github: _g, kind: _k, added: _a, leaving: _l, result: _r, ...keep } = run;
    writeFileSync(teamPath(run.company), JSON.stringify(keep, null, 2) + '\n', { mode: 0o600 });
  };
  // buildBox persists engine state through this; the team file carries it per box.
  const saveBoxState = () => saveTeam();

  let run = null;

  const view = () => {
    if (!run) return { phase: 'idle' };
    return {
      phase: run.phase, company: run.company, owner: run.owner || null, error: run.error || null,
      github: run.github || null,
      repos: run.repos || {},
      boxes: run.plan.boxes.map((b) => {
        const s = run.boxes[b.slug] || {};
        return { slug: b.slug, alias: b.alias, role: b.role, name: b.name, person: b.person, phase: s.phase || 'waiting', ip: s.ip || null, error: s.error || null };
      }),
      handover: run.phase === 'ready' && run.kind !== 'remove' ? handover() : [],
      kind: run.kind || 'start',
      leaving: run.leaving ? { slug: run.leaving.slug, name: run.leaving.name } : null,
      result: run.result || null,
    };
  };

  const handover = () => run.plan.boxes.filter((b) => !run.added || run.added.includes(b.slug)).map((b) => (b.role === 'hub'
    ? { slug: b.slug, name: b.name, role: b.role, todo: [
      'Nothing needed for tonight: the company merge runs every hour without a Claude sign-in.',
      'Sign in to Claude on it (Terminal tab), then connect Slack from its Team page so the team can ask it questions.',
      `Fill in company/about.md, voice.md, policies.md and prices.md in ${run.owner}/${run.plan.brainRepo} on GitHub. Every assistant reads them first.`,
    ] }
    : { slug: b.slug, name: b.name, role: b.role, todo: [
      `Tell ${b.name} their assistant is called "${b.slug}".`,
      `${b.name} installs Crads on their computer, chooses "I already have one" and types ${b.slug}. It shows them a key.`,
      `On this computer, find ${b.slug} in the list of minerals, press "Add a device" under it and paste their key. Their computer is then in, and yours stays in as the admin.`,
      `${b.name} signs in to Claude from the Terminal tab, with a company Claude seat or their own plan, whichever you chose.`,
    ] }));

  async function step(name, fn) { run.phase = name; saveTeam(); await fn(); }

  function drive() {
    (async () => {
      try {
        // 1. GitHub sign-in, as the owner (device flow; nothing stored).
        await step('github', async () => {
          const flow = await deviceFlow();
          run.github = { code: flow.userCode, uri: flow.verificationUri };
          const r = await flow.poll();
          if (!r.ok) throw new Error(`GitHub sign-in: ${r.reason}`);
          run.ghToken = r.token;
          run.github = null;
        });
        const gh = github(run.ghToken);
        // 2. Repos: company brain (seeded once) + one per person.
        await step('repos', async () => {
          run.owner = await gh.whoami();
          // A repo that already exists and that this team did not make is refused,
          // never reused: a name collision (acme-from-team-brain is also the brain
          // of a team called acme-from) would otherwise hand a staff box's write
          // key to somebody else's company brain (review finding 13).
          if (!run.reposMade) run.reposMade = run.repos && run.repos.brain ? [run.plan.brainRepo].concat((run.repos.people || []).map((x) => x.split('/').pop())) : [];
          const mine = async (name, desc) => {
            const r = await gh.ensureRepo(run.owner, name, desc);
            if (!r.created && !run.reposMade.includes(name)) throw new Error(`${run.owner}/${name} already exists in your GitHub and is not part of this team. Choose a different team name, or rename that repository.`);
            if (!run.reposMade.includes(name)) run.reposMade.push(name);
            saveTeam();
          };
          await mine(run.plan.brainRepo, `${run.company}: company brain (Crads for teams)`);
          const skel = companySkeleton(run.company);
          for (const [p, body] of Object.entries(skel)) await gh.ensureFile(`${run.owner}/${run.plan.brainRepo}`, p, body, `team setup: ${p}`);
          for (const b of run.plan.boxes.filter((x) => x.role === 'member')) await mine(b.repo, `${b.name}'s published notes for the ${run.company} company brain`);
          run.repos = { brain: `${run.owner}/${run.plan.brainRepo}`, people: run.plan.boxes.filter((x) => x.role === 'member').map((b) => `${run.owner}/${b.repo}`) };
        });
        // 3. Servers, one at a time, company agent first.
        await step('servers', async () => {
          for (const b of run.plan.boxes) {
            const rec = run.boxes[b.slug] = run.boxes[b.slug] || { state: {}, steps: [] };
            if (rec.state.booted) { rec.phase = 'ready'; continue; }
            // A fresh box whose name this computer already knows belongs to another
            // mineral or team: refuse rather than reuse its key (review finding 13).
            if (!rec.ownKey && !rec.state.serverId && !rec.state.sshKeyId && existsSync(join(sshDir, `${b.alias}.key`))) {
              throw new Error(`this computer already has a mineral called ${b.slug}. Choose a different team name, or forget that mineral first.`);
            }
            rec.ownKey = true;   // from here the key on this computer is this team's, so a resume never refuses it
            saveTeam();
            const boxRun = { slug: b.slug, alias: b.alias, provider: run.provider, location: run.location, serverType: run.serverType, token: run.token, state: rec.state, steps: rec.steps, phase: 'waiting' };
            const tick = setInterval(() => { rec.phase = boxRun.phase; rec.ip = boxRun.ip; }, 250);
            try { await buildBox(boxRun, { ...deps, saveState: saveBoxState }); }
            catch (e) { rec.error = String((e && e.message) || e); rec.phase = 'failed'; throw new Error(`${b.name}: ${rec.error}`); }
            finally { clearInterval(tick); }
            rec.phase = 'ready'; rec.ip = boxRun.ip; rec.error = null;
            saveTeam();
          }
        });
        // 4. Keys: minted on each box, public halves registered as deploy keys.
        await step('keys', async () => {
          for (const b of run.plan.boxes) {
            const rec = run.boxes[b.slug];
            const wanted = deployKeysFor(run.plan, b);
            rec.phase = 'keys';
            const r = await exec(b.alias, `node ${ENROL} keys /state ${wanted.map((k) => k.name).join(' ')}`);
            const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('TEAM_KEYS '));
            if (r.code !== 0 || !line) throw new Error(`${b.name}: could not make keys on the server: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
            const pubs = JSON.parse(line.slice('TEAM_KEYS '.length));
            for (const k of wanted) await gh.ensureDeployKey(`${run.owner}/${k.repo}`, `${b.slug} (${k.name})`, pubs[k.name], k.readOnly);
          }
        });
        // 5. Enrol every box, then a first merge on the agent and skills on each person.
        await step('enrol', async () => {
          for (const b of run.plan.boxes) {
            const rec = run.boxes[b.slug];
            rec.phase = 'enrolling';
            const cfg = enrolConfig(run.plan, run.owner, b);
            const r = await exec(b.alias, `node ${ENROL} enrol /state ${sq(JSON.stringify(cfg))}`);
            if (r.code !== 0 || !/TEAM_ENROLLED/.test(String(r.stdout || ''))) throw new Error(`${b.name}: enrolment failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
            rec.phase = 'ready';
          }
          for (const b of run.plan.boxes) {
            const cmd = b.role === 'hub' ? 'node /app/engine/team/team-hub.mjs /state' : 'node /app/engine/team/team-skills.mjs /state';
            await exec(b.alias, cmd).catch(() => null);   // best-effort: the schedule runs both anyway
          }
        });
        run.phase = 'ready';
        run.token = null; run.ghToken = null;
        saveTeam();
      } catch (e) {
        run.error = String((e && e.message) || e);
        run.failedAt = run.phase;
        run.phase = 'failed';
        run.github = null;
        saveTeam();
      }
    })();
  }

  // Someone's leaving (stage 3). Order matters: take their personal/ folder off
  // the box FIRST (it needs the box), then cut every key, archive their repo,
  // tell the agent, and only then delete the server. What they published stays
  // in the company brain: the company keeps the facts, the person keeps personal/.
  function driveRemove() {
    (async () => {
      const b = run.leaving;
      const hub = run.plan.boxes.find((x) => x.role === 'hub');
      try {
        await step('github', async () => {
          const flow = await deviceFlow();
          run.github = { code: flow.userCode, uri: flow.verificationUri };
          const r = await flow.poll();
          if (!r.ok) throw new Error(`GitHub sign-in: ${r.reason}`);
          run.ghToken = r.token; run.github = null;
        });
        const gh = github(run.ghToken);
        if (!run.owner) run.owner = await gh.whoami();
        await step('export', async () => {
          if (run.skipExport) { run.result = { exported: null, note: 'export skipped: the server was already gone' }; return; }
          // Their personal/ folder AND every page they marked private, as one
          // archive whose hash is checked here, and which must open, BEFORE any
          // access is cut (teams security review, 2026-10-11: a timed-out or
          // half-written export used to pass, and then the server was deleted).
          const r = await exec(b.alias, 'node /app/engine/team/team-export.mjs /state');
          const lines = String(r.stdout || '').split('\n');
          const head = lines.find((l) => l.startsWith('TEAM_EXPORT '));
          if (r.code !== 0 || !head) throw new Error(`could not copy ${b.name}'s private pages off their server. If it is already gone, choose "their server is already gone" and run this again.`);
          const meta = JSON.parse(head.slice('TEAM_EXPORT '.length));
          if (!meta.files) { run.result = { exported: null, note: `${b.name} had no private pages to hand back` }; return; }
          const buf = Buffer.from(lines[lines.indexOf(head) + 1] || '', 'base64');
          const sum = createHash('sha256').update(buf).digest('hex');
          if (buf.length !== meta.bytes || sum !== meta.sha256) throw new Error(`the copy of ${b.name}'s private pages arrived incomplete; nothing has been removed. Run this again.`);
          try { gunzipSync(buf); } catch { throw new Error(`the copy of ${b.name}'s private pages does not open; nothing has been removed. Run this again.`); }
          mkdirSync(exportDir, { recursive: true });
          const file = join(exportDir, `${b.slug}-private-${new Date().toISOString().slice(0, 10)}.tar.gz`);
          writeFileSync(file, buf, { mode: 0o600 });
          run.result = { exported: file, files: meta.files };
        });
        // From here on their access is being cut: a later add or start must not
        // hand it back (review finding 6). Cleared only when the removal finishes.
        run.departing = b.slug;
        saveTeam();
        await step('keys', async () => {
          await gh.removeDeployKeys(`${run.owner}/${run.plan.brainRepo}`, b.slug);
          await gh.removeDeployKeys(`${run.owner}/${b.repo}`, b.slug);
          if (hub) await gh.removeDeployKeys(`${run.owner}/${b.repo}`, hub.slug);
          await gh.archiveRepo(`${run.owner}/${b.repo}`);
        });
        const nextPlan = { ...run.plan, boxes: run.plan.boxes.filter((x) => x.slug !== b.slug) };
        await step('enrol', async () => {
          if (!hub) return;
          const r = await exec(hub.alias, `node ${ENROL} enrol /state ${sq(JSON.stringify(enrolConfig(nextPlan, run.owner, hub)))}`);
          if (r.code !== 0 || !/TEAM_ENROLLED/.test(String(r.stdout || ''))) throw new Error(`the company agent could not be updated: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
        });
        await step('servers', async () => {
          const rec = run.boxes[b.slug] || { state: {} };
          const client = makeClient(run.token, run.provider);
          const keyId = rec.state && rec.state.sshKeyId;
          await destroy({ token: run.token, state: rec.state, provider: run.provider, client });
          // their box's owner key (one per box, "<box>-owner") goes with the server
          if (keyId && client.deleteSshKey) { try { await client.deleteSshKey(keyId); } catch { /* harmless if it lingers; the server is gone */ } }
          try { forget(b.alias); } catch { /* the Host block is repairable by hand; the server is gone */ }
        });
        run.plan = nextPlan;
        delete run.boxes[b.slug];
        delete run.departing;
        run.left = (run.left || []).concat({ slug: b.slug, name: b.name, at: new Date().toISOString().slice(0, 10), exported: (run.result && run.result.exported) || null });
        run.phase = 'ready';
        run.token = null; run.ghToken = null;
        saveTeam();
      } catch (e) {
        run.error = String((e && e.message) || e);
        run.phase = 'failed'; run.github = null;
        saveTeam();
      }
    })();
  }

  function readBody(req, res, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e4) { res.writeHead(413); res.end(); req.removeAllListeners('end'); } });
    req.on('end', () => cb(body));
  }
  const jsonOut = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  return function handle(req, res, path) {
    if (!path.startsWith('/team/')) return false;
    if (req.method === 'GET' && path === '/team/status') { jsonOut(res, 200, view()); return true; }
    if (req.method === 'GET' && path === '/team/teams') {
      let files = [];
      try { files = readdirSync(sshDir).filter((f) => /^[a-z0-9-]+-team\.json$/.test(f)); } catch { files = []; }
      const teams = files.map((f) => { try { return JSON.parse(readFileSync(join(sshDir, f), 'utf8')); } catch { return null; } })
        // Every team with a plan, finished or not: a change that stopped half way
        // must stay on the manage screen, or the owner has no way back in to
        // retry it (found live 2026-10-11, an interrupted add vanished).
        .filter((t) => t && t.plan && t.repos && t.repos.brain)
        .map((t) => ({ company: t.company, owner: t.owner || null, brain: t.repos.brain, unfinished: t.phase !== 'ready', people: t.plan.boxes.filter((b) => b.role === 'member').map((b) => ({ slug: b.person, name: b.name, box: b.slug, ready: !!(t.boxes[b.slug] && t.boxes[b.slug].state && t.boxes[b.slug].state.booted) })), left: (t.left || []).map((l) => l.name) }));
      jsonOut(res, 200, { teams });
      return true;
    }
    // One support window across the team (stage 3). The owner chooses the scope:
    // the company agent alone, or every server, staff boxes included. The page
    // says plainly that "every server" lets Crads AI into staff boxes too. Each
    // box records its own grant in /state/support/access.json, exactly as the
    // per-box Support card does; nothing here holds any access itself.
    if (req.method === 'POST' && path === '/team/support') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const company = String(form.company || '').toLowerCase();
        const t = COMPANY_RE.test(company) ? loadTeam(company) : null;
        if (!t || !t.plan) { jsonOut(res, 404, { error: `no team called ${company} was set up from this computer` }); return; }
        const action = form.action === 'revoke' ? 'revoke' : form.action === 'grant' ? 'grant' : null;
        if (!action) { jsonOut(res, 400, { error: 'action must be grant or revoke' }); return; }
        const hours = parseInt(form.hours ?? 24, 10);
        if (action === 'grant' && (!Number.isInteger(hours) || hours < 1 || hours > 72)) { jsonOut(res, 400, { error: 'hours must be 1 to 72' }); return; }
        // revoke always covers every server: closing access is never partial
        const boxes = t.plan.boxes.filter((b) => (action === 'revoke' || form.scope === 'all') ? true : b.role === 'hub');
        const results = [];
        for (const b of boxes) {
          const r = await exec(b.alias, `node /app/engine/support/support-access.mjs /state ${action}${action === 'grant' ? ` ${hours}` : ''}`).catch((e) => ({ code: -1, stdout: '', stderr: String(e && e.message || e) }));
          results.push({ slug: b.slug, name: b.name, ok: r.code === 0, said: String(r.stdout || r.stderr || '').trim().split('\n').pop().slice(0, 200) });
        }
        jsonOut(res, results.every((x) => x.ok) ? 200 : 502, { ok: results.every((x) => x.ok), action, results });
      });
      return true;
    }
    if (req.method === 'POST' && (path === '/team/add' || path === '/team/remove')) {
      readBody(req, res, (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        if (run && !['ready', 'failed'].includes(run.phase)) { jsonOut(res, 409, { error: 'a team change is already running' }); return; }
        const company = String(form.company || '').toLowerCase();
        const prev = COMPANY_RE.test(company) ? loadTeam(company) : null;
        if (!prev || !prev.plan) { jsonOut(res, 404, { error: `no team called ${company} was set up from this computer` }); return; }
        if (!String(form.token || '')) { jsonOut(res, 400, { error: `the ${providerOf(prev.provider || DEFAULT_PROVIDER).label} API token is needed (it is never stored)` }); return; }
        const base = {
          company, provider: prev.provider || DEFAULT_PROVIDER, location: prev.location || null, serverType: prev.serverType || null,
          boxes: prev.boxes || {}, repos: prev.repos || {}, owner: prev.owner || null, left: prev.left || [],
          phase: 'starting', error: null, github: null, token: String(form.token), ghToken: null,
        };
        for (const rec of Object.values(base.boxes)) { rec.error = null; if (!(rec.state && rec.state.booted)) rec.phase = 'waiting'; }
        if (prev.departing && !(path === '/team/remove' && prev.plan.boxes.some((x) => x.slug === prev.departing && x.person === String(form.person || '')))) {
          jsonOut(res, 409, { error: `finish removing ${(prev.plan.boxes.find((x) => x.slug === prev.departing) || {}).name || prev.departing} first: choose Someone's leaving for them again` }); return;
        }
        base.departing = prev.departing || undefined;
        base.reposMade = prev.reposMade;
        if (path === '/team/add') {
          // A failed add is resumed by sending the same names: they are already planned.
          const names = (Array.isArray(form.people) ? form.people : []).map((p) => String(p.name || '').trim()).filter(Boolean);
          const have = new Set(prev.plan.boxes.map((b) => b.name));
          let plan = prev.plan; let added = prev.plan.boxes.filter((b) => names.includes(b.name)).map((b) => b.slug);
          const fresh = names.filter((n) => !have.has(n));
          if (fresh.length) {
            try { const x = extendPlan(prev.plan, fresh.map((n) => ({ name: n }))); plan = x.plan; added = added.concat(x.added); }
            catch (e) { jsonOut(res, 400, { error: e.message }); return; }
          }
          if (!added.length) { jsonOut(res, 400, { error: 'add at least one person' }); return; }
          run = { ...base, plan, kind: 'add', added };
          saveTeam();
          drive();
          jsonOut(res, 200, { ok: true, boxes: added });
          return;
        }
        const b = prev.plan.boxes.find((x) => x.role === 'member' && x.person === String(form.person || ''));
        if (!b) { jsonOut(res, 400, { error: 'no such person on this team' }); return; }
        if (String(form.confirm || '').trim() !== b.name) { jsonOut(res, 400, { error: `Type ${b.name}'s name exactly to confirm.` }); return; }
        run = { ...base, plan: prev.plan, kind: 'remove', leaving: b, skipExport: form.skip_export === true };
        driveRemove();
        jsonOut(res, 200, { ok: true, leaving: b.slug });
      });
      return true;
    }
    if (req.method === 'POST' && path === '/team/start') {
      readBody(req, res, (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        if (run && !['ready', 'failed'].includes(run.phase)) { jsonOut(res, 409, { error: 'a team build is already running' }); return; }
        const company = String(form.company || '').toLowerCase();
        const providerId = String(form.provider || DEFAULT_PROVIDER);
        if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerId)) { jsonOut(res, 400, { error: 'unknown provider' }); return; }
        if (!String(form.token || '')) { jsonOut(res, 400, { error: `a ${providerOf(providerId).label} API token is required` }); return; }
        let plan;
        try { plan = planTeam(company, Array.isArray(form.people) ? form.people : []); }
        catch (e) { jsonOut(res, 400, { error: e.message }); return; }
        // Resume: a team file for this name carries each box's engine state, so
        // nothing is created twice. The plan must match it.
        const prev = loadTeam(company);
        if (prev && prev.departing) { jsonOut(res, 409, { error: `finish removing ${(prev.plan.boxes.find((x) => x.slug === prev.departing) || {}).name || prev.departing} first: choose Someone's leaving for them again` }); return; }
        if (prev && JSON.stringify(prev.plan.boxes.map((b) => b.slug)) !== JSON.stringify(plan.boxes.map((b) => b.slug))) {
          jsonOut(res, 409, { error: `a team called ${company} was started with different people; finish it, or use another team name` }); return;
        }
        run = {
          company, plan, provider: (prev && prev.provider) || providerId,
          location: String(form.location || '') || (prev && prev.location) || null,
          serverType: String(form.server_type || '') || (prev && prev.serverType) || null,
          boxes: (prev && prev.boxes) || {}, repos: (prev && prev.repos) || {}, owner: (prev && prev.owner) || null,
          phase: 'starting', error: null, github: null,
          token: String(form.token), ghToken: null,
        };
        // A resumed run starts every unfinished box from "waiting", not from the
        // "failed" the last attempt left on it (seen in the first live build).
        for (const rec of Object.values(run.boxes)) { rec.error = null; if (!(rec.state && rec.state.booted)) rec.phase = 'waiting'; }
        drive();
        jsonOut(res, 200, { ok: true, boxes: plan.boxes.map((b) => b.slug) });
      });
      return true;
    }
    res.writeHead(404); res.end();
    return true;
  };
}
