#!/usr/bin/env node
// plan.mjs: the deterministic /move-in planner (spec 2026-10-17-adopt-existing-server.md § 3).
//
//   node plan.mjs <state-dir>            write cockpit/move-in.json + move-in.md, print MOVEIN_PLAN {summary}
//
// Reads the host inventory host setup collected (.kernel/move-in/host-inventory.json)
// and the brain mounted at /state, and turns what the server already does into
// steps a person approves one at a time. It changes nothing but the two plan
// files: applying a step is apply.mjs, and a step on the server itself is the
// app's job over SSH (host-ops.mjs). Running it again keeps every step the
// person has already approved, done, skipped or undone, so a re-plan after the
// server changes never forgets work.
//
// THE MAPPING (spec § 3 table), every item of the inventory lands somewhere:
//   crontab line asking Claude   -> a DISABLED cadence entry (+ a skill made from
//                                   its prompt when the prompt is not one already),
//                                   then a cutover step
//   crontab line running a script-> a DISABLED Scripts row, then a cutover step; or
//                                   "still on the server" when its program is host-only
//   @reboot lines, services,     -> "still on the server"
//   containers, listeners
//   a Telegram bot               -> token + chat id carried over (Telegram shows
//                                   connected, the host program keeps answering);
//                                   who answers is a separate, later step
//   skills, CLAUDE.md, MCP       -> notes: nothing changes, each says what happens
//   servers, hooks, backups, git
import { readFileSync, existsSync, statSync, accessSync, constants, readdirSync } from 'node:fs';
import { ADOPTED_STATE_MD } from '../box/state-md.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCronLine, analyzeCommand, cronToSchedule, readJobDefinition, slashSkill, toContainer, underDir, homeOf,
  redact, uniqueId, slug, telegramGap, isTelegramish, mcpPlace, envRefs, hookInterpreter, RUNNER_RE,
  sentences, remoteReach, parseGitRemoteUrl, mineralRewrite,
} from './lib.mjs';
import { sha256 } from './host-ops.mjs';
import { parseEnvFile } from '../cron/scripts-lib.mjs';
import { EVERY_FLOOR_MIN } from '../cron/cadence-lib.mjs';
import { readInventory, readPlan, readJson, savePlan, withLock, NEW_FILES } from './store.mjs';
import { buildBrainSection } from '../box/brain-claude-md.mjs';
import { isMain } from '../lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SKILLS = path.resolve(HERE, '..', 'skills');
const P = path.posix;

// Engine-written files that land in cockpit/, which an adopted brain tracks.
export const ENGINE_COCKPIT_FILES = ['cockpit/run-ledger.jsonl', 'cockpit/brain-push.log', 'cockpit/skill-runs.json',
  'cockpit/last-skill-runs.json', 'cockpit/last-script-runs.json', 'cockpit/heartbeat.json', 'cockpit/heartbeat-full.json', 'cockpit/data.json'];

function executable(p) {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true); } catch { return false; }
}
// Is `name` a program inside this container? Bare names search PATH.
export function containerHas(name, envPath = process.env.PATH || '') {
  if (name.includes('/')) return executable(name);
  return envPath.split(':').filter(Boolean).some((d) => executable(path.join(d, name)));
}

const rd = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const title = (id) => id.replace(/^crads-/, '').split('-').filter(Boolean).map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const today = () => new Date().toISOString().slice(0, 10);

// The url of a remote, from the brain's own git config (a linked worktree's
// .git file points at a folder on the server, which the mineral cannot read).
function remoteUrlOf(stateDir, name) {
  const cfg = rd(path.join(stateDir, '.git', 'config'));
  return cfg == null ? '' : parseGitRemoteUrl(cfg, name);
}
export { remoteUrlOf };

// The header comment of a script, as its one-line description.
function headerLine(text) {
  for (const l of String(text || '').split('\n').slice(0, 12)) {
    const m = l.match(/^\s*(?:\/\/|#)\s*(?!!)(.{8,})$/);
    if (m && !/^(eslint|@ts|-\*-|usage)/i.test(m[1])) return m[1].replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return '';
}

/**
 * The plan, pure apart from reading the brain. `opts`:
 *   has(name)       program inside the container (default: PATH search)
 *   engineSkills    dir of engine skill .md files (default: this image's)
 *   prior           the existing plan, whose decided steps are kept
 *   now             ISO time for generated_at
 */
export function buildPlan(stateDir, inv, opts = {}) {
  const has = opts.has || ((n) => containerHas(n));
  const prior = opts.prior || null;
  const nowIso = opts.now || new Date().toISOString();
  const ymd = nowIso.slice(0, 10);
  const login = String(inv.login || 'root');
  const brainRoot = String(inv.brain_root || '');
  const home = homeOf(login);
  const inBrain = (p) => toContainer(p, brainRoot, stateDir);
  const exists = (p) => existsSync(p);

  const steps = [];
  const still = [];
  const items = [];
  const priorSteps = new Map(((prior && prior.steps) || []).map((s) => [s.id, s]));
  // A source already planned keeps its job id, so a re-plan is stable.
  const priorJob = new Map();
  for (const s of (prior && prior.steps) || []) if (s.source && s.source.key && s.job) priorJob.set(s.source.key, s.job.id);

  // What is taken: the person's skills, their cadence and scripts, and ours.
  const cadence = readJson(path.join(stateDir, 'cockpit', 'cadence.json'), {}) || {};
  const cadJobs = cadence.version === 2 && cadence.jobs ? cadence.jobs : cadence;
  const scripts = readJson(path.join(stateDir, 'cockpit', 'scripts.json'), {}) || {};
  const scriptIds = new Set([...Object.keys(scripts.scripts || {}), ...Object.keys(scripts.removed || {})]);
  const skillDir = (id) => path.join(stateDir, '.claude', 'skills', id);
  const ourIds = new Set([...priorJob.values()]);
  const usedSkill = new Set(); const usedScript = new Set();
  let engineNames = [];
  try { engineNames = readdirSync(opts.engineSkills || ENGINE_SKILLS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(); } catch { /* no engine skills here */ }
  // an engine skill's name is not free either: taking it would push Crads-AI's own copy to crads-<name>
  const skillTaken = (id) => usedSkill.has(id) || engineNames.includes(id) || engineNames.includes(id.replace(/^crads-/, ''))
    || (!ourIds.has(id) && (existsSync(skillDir(id)) || Object.prototype.hasOwnProperty.call(cadJobs, id)));
  const scriptTaken = (id) => usedScript.has(id) || (!ourIds.has(id) && scriptIds.has(id));

  const add = (s) => { steps.push({ changes: [], undo: [], details: [], state: 'pending', ...s }); return s.id; };
  const stillIds = new Set();
  const stillOn = (x) => {
    let id = x.id; for (let n = 2; stillIds.has(id); n++) id = `${x.id}-${n}`;
    stillIds.add(id); still.push({ ...x, id }); return `still:${id}`;
  };

  // ---- the brain's git remote, read before the crontab --------------------------------
  // Crads-AI's nightly push runs inside the mineral. A remote that only the
  // server can reach (an SSH alias from its ~/.ssh/config, a folder on the
  // server) cannot be used from there, so until GitHub is connected through the
  // app the person's own backup job stays on the server (rehearsal T4 finding 8).
  const git = inv.git && typeof inv.git === 'object' ? inv.git : null;
  const remoteUrl = git ? String(git.url || '') || remoteUrlOf(stateDir, String(git.remote || 'origin')) : '';
  // Connect GitHub gives the MINERAL its own HTTPS way to an alias remote, in its
  // own git config (HOME is <brain>/.kernel/home in an adopted container), and
  // leaves the shared .git/config alone. So that is where "connected" shows.
  const routed = remoteUrl ? mineralRewrite(remoteUrl, rd(path.join(stateDir, '.kernel', 'home', '.gitconfig'))) : '';
  const reach = remoteReach(routed || remoteUrl);
  const remoteBlock = git && git.remote && reach.usable === false ? {
    reach,
    hold: 'Connect GitHub first. Crads-AI\'s nightly backup cannot push to your repository from inside your mineral yet, so your own backup job keeps running on the server until it can. Connect GitHub from the app, then make the plan again.',
  } : null;

  // ---- the crontab ---------------------------------------------------------------
  const crontab = Array.isArray(inv.crontab) ? inv.crontab : [];
  const settings = [];
  const seenKeys = new Map();
  for (const row of crontab) {
    const user = String(row.user || login);
    const text = String(row.text ?? '');
    const display = redact(text);
    // the same line twice is two jobs: the second gets its own key, so a re-plan keeps both apart
    const k0 = `crontab:${user}:${sha256(text).slice(0, 16)}`;
    const nth = (seenKeys.get(k0) || 0) + 1; seenKeys.set(k0, nth);
    const key = nth > 1 ? `${k0}:${nth}` : k0;
    const ref = { type: 'crontab', user, line_no: row.line_no, display, key, text_sha256: sha256(text) };
    const c = parseCronLine(text);
    if (c.kind === 'blank' || c.kind === 'comment') { items.push({ ref: key, display, to: 'nothing: a comment or blank line' }); continue; }
    if (c.kind === 'setting') { settings.push({ ref, name: c.name }); continue; }
    if (c.kind === 'unreadable') {
      items.push({ ref: key, display, to: stillOn({ id: `cron-${slug(display, 24)}-${key.slice(-6)}`, name: 'A crontab line', what: display, why: `Crads-AI could not read it: ${c.reason}`, source: ref }) });
      continue;
    }
    if (c.kind === 'reboot') {
      const tg = isTelegramish(c.command);
      items.push({ ref: key, display, to: stillOn({ id: `reboot-${key.slice(-8)}`, name: tg ? 'Your Telegram program' : 'Started when the server starts',
        what: display, why: tg ? 'it answers your Telegram bot until you switch that over' : 'it runs all the time, so it stays on the server in this version', source: ref, telegram: tg, always_on: true }) });
      continue;
    }
    const a = analyzeCommand(c.command, { login });
    const assumptions = [];
    if (a.percent) assumptions.push('the line uses %, which cron turns into input; that input is not carried over');

    // -- a Claude job? -----------------------------------------------------------------
    // Only a prompt the plan can copy word for word becomes a skill. A prompt
    // the shell or a job runner builds when it runs is never guessed at: the
    // line is carried over as a script that runs the same command inside the
    // mineral, where `claude` is installed (adopt rehearsal T4 finding 4: a
    // placeholder skill that says "find the words elsewhere" does not do the job).
    let claude = null;
    let runsClaude = null;   // a script that calls Claude itself: { how, skillToo }
    if (a.claude) {
      if (a.claude.prompt != null && !a.claude.promptExpands) {
        claude = { prompt: a.claude.prompt, skill: null, how: 'it runs claude -p', flags: a.claude.flags };
        if (a.claude.flags.length) assumptions.push(`its own options (${a.claude.flags.join(', ')}) are not carried over: Crads-AI runs scheduled skills with its own settings`);
      } else {
        runsClaude = { how: 'This line asks Claude to do something with words the shell puts together each time it runs, so the plan cannot copy them', skillToo: null };
      }
    } else if (a.runner) {
      const runnerHost = P.resolve(a.cwdHost, a.runner.script);
      const runnerIn = inBrain(runnerHost);
      let def = { found: false, why: 'the job runner is outside your brain folder, so its definitions could not be read' };
      if (runnerIn) {
        const dir = P.dirname(runnerIn);
        def = { found: false, why: `no job definitions were found beside ${P.basename(runnerHost)}` };
        for (const f of ['jobs.json', 'jobs.mjs', 'jobs.js', 'jobs.cjs']) {
          const t = rd(P.join(dir, f));
          if (t == null) continue;
          def = readJobDefinition(t, f, a.runner.job);
          if (def.found) break;
        }
      }
      const job = a.runner.job;
      if (def.found && def.claude && def.prompt != null) {
        claude = { prompt: def.prompt, skill: def.skill, how: `it calls your job runner, and its definition for ${job} carries a prompt`, flags: [], runnerJob: job };
      } else if (def.found && def.claude) {
        const same = def.skill || (/^[a-z0-9][a-z0-9-]{0,62}$/.test(job) && existsSync(path.join(skillDir(job), 'SKILL.md')) ? job : null);
        runsClaude = { how: `This job asks Claude to do something with a prompt your job runner builds each time it runs, so the plan cannot copy its words`, skillToo: same, runner: true };
      } else {
        assumptions.push(`it calls your job runner, and ${def.why}, so it is treated as a plain script`);
      }
    }

    const sched = cronToSchedule(c.fields, { floor: claude ? EVERY_FLOOR_MIN : 1, todayYmd: ymd });
    if (sched.note) assumptions.push(sched.note);

    if (claude) {
      // the skill that runs it: theirs when the prompt is only `/name`, else one made from the prompt
      const named = claude.skill || slashSkill(claude.prompt);
      const personHas = named && /^[a-z0-9][a-z0-9-]{0,62}$/.test(named) && existsSync(path.join(skillDir(named), 'SKILL.md'));
      let jobId; let newSkill = null;
      if (personHas && !usedSkill.has(named)) { jobId = named; }
      else {
        const base = claude.runnerJob || named || claude.prompt.split(/\s+/).slice(0, 4).join(' ');
        jobId = priorJob.get(key) || uniqueId(base, skillTaken);
        newSkill = {
          id: jobId,
          path: `.claude/skills/${jobId}/SKILL.md`,
          text: `---\nname: ${jobId}\ndescription: Moved in from your server's schedule. ${redact(String(claude.prompt).split('\n')[0]).slice(0, 140).replace(/[\r\n]+/g, ' ')}\n---\n\n# ${title(jobId)}\n\n`
            + `This job ran on your server's schedule before you moved in to Crads-AI. It asked Claude to do the following, word for word:\n\n${claude.prompt}\n`,
        };
      }
      usedSkill.add(jobId);
      const entry = { enabled: false, deliver: false, schedule: sched.schedule };
      const already = Object.prototype.hasOwnProperty.call(cadJobs, jobId) && !ourIds.has(jobId);
      const addId = `cadence-${jobId}`;
      if (!already) {
        add({
          id: addId, kind: 'cadence-add', side: 'container', title: `Schedule ${title(jobId)} in Crads-AI (switched off)`,
          what: sentences(`Adds ${title(jobId)} to your Skills page with the same times as your server, switched off`,
            newSkill ? `It makes the skill ${jobId} from the job's prompt` : `It runs your own /${jobId} skill`),
          why: sentences(`This line asks Claude to do something (${claude.how})`, assumptions),
          source: ref, job: { target: 'cadence', id: jobId, entry, skill: newSkill },
          changes: [{ file: 'cockpit/cadence.json', add: `jobs.${jobId}` }, ...(newSkill ? [{ file: newSkill.path, create: true }] : [])],
          undo_words: 'takes the entry out again, and the new skill if it made one, so the files are as they were.',
        });
      }
      add({
        id: `cutover-cadence-${jobId}`, kind: 'cutover', side: 'host', after: already ? null : addId,
        title: `Switch ${title(jobId)} over to Crads-AI`,
        what: `Switches ${title(jobId)} on in Crads-AI, then switches the server's line off by putting "# crads-move-in" in front of it. Run it once from this page first and check the result.`,
        why: 'One owner per job: it runs on your server or in Crads-AI, never both. The line is commented, never deleted.',
        source: ref, job: { target: 'cadence', id: jobId },
        host_op: { op: 'cron-comment', user, text_sha256: ref.text_sha256 },
        half: { action: 'enable', target: 'cadence', id: jobId, when: 'before' },
        changes: [{ file: 'cockpit/cadence.json', set: `jobs.${jobId}.enabled` }, { host: 'crontab', user, comment: true }],
        undo_words: 'takes "# crads-move-in" off the server\'s line again, then switches the Crads-AI copy off.',
      });
      items.push({ ref: key, display, to: already ? `cutover-cadence-${jobId}` : addId });
      continue;
    }

    // -- a plain script -------------------------------------------------------------------
    let argv = null; let cwd = stateDir; let hostOnly = '';
    if (a.simple) {
      const mapPathArg = (x) => {
        const abs = x.startsWith('/') ? x : (x.includes('/') || /\.[a-z]{1,4}$/i.test(x)) ? P.resolve(a.cwdHost, x) : null;
        if (!abs) return { v: x };
        const cp = inBrain(abs);
        return cp ? { v: cp, mapped: true } : { v: x, outside: P.isAbsolute(x) || abs !== x ? abs : null };
      };
      const out = [];
      const a0 = a.argv[0];
      const b0 = P.basename(a0);
      if (a0.includes('/')) {
        const abs = P.resolve(a.cwdHost, a0);
        const cp = inBrain(abs);
        if (cp && exists(cp)) out.push(cp);
        else if (['node', 'nodejs', 'python3', 'python', 'bash', 'sh', 'bun', 'deno'].includes(b0) && has(b0)) {
          out.push(b0); assumptions.push(`your server runs ${a0}; inside your mineral it uses its own ${b0}`);
        } else hostOnly = `its program ${a0} is only on your server`;
      } else if (has(a0)) out.push(a0);
      else hostOnly = `${a0} is not installed inside your mineral`;
      const interp = ['node', 'nodejs', 'python3', 'python', 'bash', 'sh', 'bun', 'deno', 'tsx', 'perl', 'ruby'].includes(b0);
      let scriptSeen = false;
      for (let i = 1; i < a.argv.length && !hostOnly; i++) {
        const m = mapPathArg(a.argv[i]);
        if (interp && !scriptSeen && ['-m', '-c', '-e', '--eval', '-r', '--require'].includes(a.argv[i - 1])) scriptSeen = true;   // a module or inline code, not a file
        const isScript = interp && !scriptSeen && !a.argv[i].startsWith('-');
        if (isScript) {
          scriptSeen = true;
          if (!m.mapped) hostOnly = `its script ${a.argv[i]} is outside your brain folder, so your mineral cannot see it`;
          else if (!exists(m.v)) hostOnly = `its script ${a.argv[i]} is not in your brain folder`;
        } else if (m.outside && underDir(home, m.outside) && !inBrain(m.outside)) {
          hostOnly = `it uses ${a.argv[i]}, which is in your home folder outside the brain, so your mineral cannot see it`;
        }
        out.push(m.v);
      }
      if (!hostOnly) {
        argv = a.env.length ? ['env', ...a.env, ...out] : out;
        const cc = inBrain(a.cwdHost);
        if (cc) cwd = cc;
        else assumptions.push(`cron ran it from ${a.cwdHost}; inside your mineral it runs from your brain folder`);
        if (a.redirs.length) assumptions.push(`its output went to ${a.redirs.join(' ')}; Crads-AI keeps the last lines on the Scripts row instead`);
      }
    } else if (a.complexWhy) {
      let cmd = String(c.command).replace(/\\%/g, '%')
        .replace(/(^|[\s=:'"(])~(?=\/)/g, `$1${home}`).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
      if (brainRoot) cmd = cmd.split(brainRoot.replace(/\/+$/, '')).join(stateDir);
      if (cmd.includes(`${home}/`) || /(^|[\s;&|(])cd(\s*$|\s*[;&|])/.test(cmd)) hostOnly = `${a.complexWhy}, and it reaches into your home folder outside the brain`;
      else {
        argv = ['bash', '-c', cmd];
        if (!runsClaude) assumptions.push(`${a.complexWhy}, so it is carried over as one bash command`);
        assumptions.push('Run it once here before switching it on');
      }
    }
    if (argv && redact(argv.join(' ')) !== argv.join(' ')) {
      hostOnly = 'its line carries something that looks like a password or token, and the Scripts list lives in a folder your brain repository keeps, so the plan will not copy it there. Put the value in a settings file under secrets/ and ask your assistant to add the script';
      argv = null;
    }
    if (!argv) {
      items.push({ ref: key, display, to: stillOn({ id: `cron-${key.slice(-10)}`, name: 'A scheduled job', what: display, why: hostOnly || a.complexWhy || 'it could not be read', source: ref,
        ...(runsClaude ? { runs_claude: true } : {}) }) });
      continue;
    }
    // a one-line bash command is named after the first file it names (prompts/standup.txt -> standup)
    const inCmd = argv[0] === 'bash' && argv[1] === '-c' ? (String(argv[2]).match(/[A-Za-z0-9_.\/-]*[A-Za-z0-9_-]\.[a-z]{1,4}(?![A-Za-z0-9])/i) || [])[0] : null;
    const nameSrc = a.runner ? a.runner.job : inCmd || (argv.find((x, i) => i > 0 && /\.[a-z]{1,4}$/i.test(x) && x.includes('/')) || argv[argv[0] === 'env' ? a.env.length + 1 : 0]);
    const id = priorJob.get(key) || uniqueId(P.basename(String(nameSrc)), scriptTaken);
    usedScript.add(id);
    const scriptFile = argv.find((x) => x.startsWith(stateDir + '/') && /\.[a-z]{1,4}$/i.test(x));
    const shown = redact(argv[0] === 'bash' && argv[1] === '-c' ? String(argv[2]) : argv.map((x) => (x.startsWith(stateDir + '/') ? x.slice(stateDir.length + 1) : x)).join(' '));
    const description = runsClaude
      ? (runsClaude.runner ? `Runs the ${a.runner.job} job through your own job runner, which asks Claude to do it.` : 'Runs your scheduled Claude command, the same way your server did.')
      : (scriptFile && headerLine(rd(scriptFile))) || 'Moved in from your server\'s crontab.';
    // a script that calls Claude can take many minutes; a plain one keeps the usual limit
    const entry = { enabled: false, name: title(id), description, argv, cwd, schedule: sched.schedule, timeout_s: runsClaude ? 1800 : 600 };
    const isBackup = /backup|snapshot/i.test(display);
    const hold = isBackup && remoteBlock ? remoteBlock.hold : null;
    add({
      id: `script-${id}`, kind: 'script-add', side: 'container', title: `Add ${title(id)} to your Scripts (switched off)`,
      what: sentences(`Adds ${title(id)} to the Scripts list on your Skills page with the same times as your server, switched off`,
        runsClaude && `It runs ${runsClaude.runner ? 'your own job runner' : 'the same command'} (${shown}) inside your mineral, and that asks Claude to do the job`),
      why: runsClaude
        ? sentences(runsClaude.how,
          `Running ${runsClaude.runner ? 'your own runner' : 'the same command'} keeps the job exactly as it was: ${runsClaude.runner ? 'the runner' : 'it'} calls claude itself, which is installed inside your mineral and uses its own Claude sign-in`,
          runsClaude.skillToo && `Your brain also has a /${runsClaude.skillToo} skill. If it does the same job, you can schedule that on the Skills page instead and skip this step`,
          assumptions)
        : sentences('This line runs a program without Claude', assumptions),
      source: ref, job: { target: 'scripts', id, entry, ...(runsClaude ? { runs_claude: true } : {}) },
      changes: [{ file: 'cockpit/scripts.json', add: `scripts.${id}` }],
      undo_words: 'takes the row out again, so the file is as it was.',
    });
    add({
      id: `cutover-script-${id}`, kind: 'cutover', side: 'host', after: `script-${id}`,
      title: `Switch ${title(id)} over to Crads-AI`,
      what: `Switches ${title(id)} on in Crads-AI, then switches the server's line off by putting "# crads-move-in" in front of it. Run it once from this page first and check the result.`,
      why: sentences('One owner per job: it runs on your server or in Crads-AI, never both. The line is commented, never deleted',
        isBackup && 'This one looks like a backup. Crads-AI also backs up every night (into backups/crads/); switch this over only after one Crads-AI backup has been restored as a test'),
      ...(hold ? { hold } : {}),
      source: ref, job: { target: 'scripts', id },
      host_op: { op: 'cron-comment', user, text_sha256: ref.text_sha256 },
      half: { action: 'enable', target: 'scripts', id, when: 'before' },
      changes: [{ file: 'cockpit/scripts.json', set: `scripts.${id}.enabled` }, { host: 'crontab', user, comment: true }],
      undo_words: 'takes "# crads-move-in" off the server\'s line again, then switches the Crads-AI copy off.',
    });
    items.push({ ref: key, display, to: `script-${id}` });
  }
  if (settings.length) {
    const sid = add({ id: 'note-cron-settings', kind: 'note', side: 'container', title: 'Settings at the top of your crontab',
      what: `Your crontab sets ${settings.map((s) => s.name).join(', ')}. Jobs moved into Crads-AI run with your mineral's own settings instead; nothing changes on your server.`,
      why: settings.some((s) => /^(CRON_)?TZ$/.test(s.name)) ? 'It sets a time zone. Your mineral uses the server\'s own time zone; check the times on the Skills page match.' : 'Crads-AI does not read these lines.',
      details: settings.map((s) => ({ name: s.name, words: s.ref.display })) });
    for (const s of settings) items.push({ ref: s.ref.key, display: s.ref.display, to: sid });
  }

  // ---- services, containers, listeners -----------------------------------------------------
  const units = Array.isArray(inv.units) ? inv.units : [];
  let tgProgram = null;
  for (const u of units) {
    const name = String(u.name || '');
    const tg = isTelegramish(`${name} ${u.exec_start || ''}`);
    if (tg && !tgProgram && /\.service$/.test(name)) tgProgram = { unit: u };
    const timer = /\.timer$/.test(name);
    items.push({ ref: `unit:${u.scope || 'system'}:${name}`, display: name, to: stillOn({
      id: `unit-${slug(name, 50)}`, name, what: redact(String(u.exec_start || 'a service')),
      why: tg ? 'it answers your Telegram bot until you switch that over' : timer ? 'a systemd timer; this version leaves timers on the server' : 'it runs all the time, so it stays on the server in this version',
      source: { type: 'unit', name, scope: u.scope || 'system', active: u.active !== false }, telegram: tg, always_on: !timer }) });
  }
  if (!tgProgram) {
    const r = still.find((x) => x.telegram && x.source && x.source.type === 'crontab');
    if (r) tgProgram = { reboot: r };
  }
  for (const k of Array.isArray(inv.containers) ? inv.containers : []) {
    const name = String(k.name || '');
    items.push({ ref: `container:${name}`, display: name, to: stillOn({ id: `container-${slug(name, 50)}`, name, what: `a ${k.image || 'docker'} container (${k.status || 'status unknown'})`,
      why: 'your mineral leaves your other containers alone', source: { type: 'container', name }, always_on: true }) });
  }
  const listeners = (Array.isArray(inv.listeners) ? inv.listeners : []).map(String);
  if (listeners.length) {
    stillOn({ id: 'listeners', name: 'Open ports', what: listeners.join(', '), why: 'programs on your server listen here; your mineral does not change your firewall', source: { type: 'listeners' } });
    for (const l of listeners) items.push({ ref: `listener:${l}`, display: l, to: 'still:listeners' });
  }

  // ---- Telegram ---------------------------------------------------------------------------------
  const envFiles = (Array.isArray(inv.env_files) ? inv.env_files : []).map(String).filter((f) => !P.isAbsolute(f) && !f.split('/').includes('..'));
  let tg = null;
  for (const rel of envFiles) {
    const t = rd(path.join(stateDir, rel));
    if (t == null) continue;
    const env = parseEnvFile(t);
    if (env.TELEGRAM_BOT_TOKEN) { tg = { rel, token: env.TELEGRAM_BOT_TOKEN, chat: env.TELEGRAM_CHAT_ID || '' }; break; }
  }
  for (const rel of envFiles) items.push({ ref: `env:${rel}`, display: rel, to: tg && tg.rel === rel ? 'telegram-carry' : 'note-env-files' });
  const tgInfo = { carried: false, answered_by: 'host', gap: null, env_file: tg ? tg.rel : null };
  if (tg) {
    let src = null; let gapWhy = '';
    if (tgProgram && tgProgram.unit) {
      const ex = String(tgProgram.unit.exec_start || '');
      const file = ex.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')).find((w) => /\.(m?js|cjs|py|ts|sh)$/.test(w));
      const cp = file ? inBrain(P.resolve(String(tgProgram.unit.working_directory || brainRoot), file)) : null;
      src = cp ? rd(cp) : null;
      if (src == null) gapWhy = 'its code is not in your brain folder, so the plan could not see what it does';
    }
    const gap = telegramGap(src);
    tgInfo.gap = gap;
    add({
      id: 'telegram-carry', kind: 'telegram-carry', side: 'container', title: 'Carry your Telegram bot over',
      what: `Copies your bot's token${tg.chat ? ' and chat' : ''} from ${tg.rel} into your mineral's Telegram settings, so the app shows Telegram connected with the same bot and no re-pairing. Your own program keeps answering it.`,
      why: sentences('Only one program can read a bot\'s messages; two readers steal each other\'s. So this step only carries the details over, and Crads-AI reads nothing',
        'While you are moving in, Crads-AI sends nothing to Telegram either. Once you finish moving in, it can send you the results of jobs set to "Send me the result", while your own program still answers the bot',
        !tg.chat && 'No TELEGRAM_CHAT_ID was found, so Telegram will need its chat set before Crads-AI can send'),
      source: { type: 'env', file: tg.rel, display: `${tg.rel}: TELEGRAM_BOT_TOKEN=<hidden>${tg.chat ? ', TELEGRAM_CHAT_ID' : ''}` },
      changes: [{ file: 'secrets/telegram_bot_token', write: true, mode: '0600' }, ...(tg.chat ? [{ file: 'secrets/telegram_chat_id', write: true, mode: '0600' }] : []),
        { file: '.kernel/telegram-reader', write: 'host' }],
      telegram: { env_file: tg.rel },
      undo_words: 'puts the Telegram settings back exactly as they were before.',
    });
    if (tgProgram) {
      const lacks = gap == null ? [`unknown: ${gapWhy || 'the plan could not tell'}. Check what your program does before you switch over`] : gap;
      const u = tgProgram.unit;
      // Only after Finish (rehearsal T4 finding 5): while moving in, Crads-AI's
      // own reader is held back, so stopping the person's program now would
      // leave nobody answering. It never counts toward finishing (lib settled()).
      add({
        id: 'telegram-cutover', kind: 'telegram-cutover', side: 'host', after: 'telegram-carry', after_finish: true,
        title: 'Let Crads-AI answer your Telegram bot',
        what: u ? `Stops and switches off ${u.name} on your server (it is never removed), then starts Crads-AI's own Telegram reader.`
          : 'Switches off the crontab line that starts your Telegram program (by putting "# crads-move-in" in front of it; the program already running stops at the next restart), then starts Crads-AI\'s own Telegram reader.',
        why: sentences('This step is available once you finish moving in, and it does not count toward finishing. While you are moving in, Crads-AI\'s own Telegram reader is held back, so switching your program off now would leave nobody answering your bot',
          lacks.length ? `Your program does things Crads-AI's Telegram does not do yet: ${lacks.join('; ')}. Switch over only when you are happy to lose those, or keep your own program answering`
            : 'The plan found nothing your program does that Crads-AI\'s Telegram cannot'),
        source: u ? { type: 'unit', name: u.name, scope: u.scope || 'system', display: u.name } : tgProgram.reboot.source,
        host_op: u ? { op: 'unit-disable', name: String(u.name), scope: u.scope === 'user' ? 'user' : 'system' } : { op: 'cron-comment', user: tgProgram.reboot.source.user, text_sha256: tgProgram.reboot.source.text_sha256 },
        half: { action: 'telegram-reader', when: 'after' },
        details: lacks.map((w) => ({ name: 'Not in Crads-AI yet', words: w })),
        changes: [u ? { host: 'systemd', unit: u.name, disable: true } : { host: 'crontab', comment: true }, { file: '.kernel/telegram-reader', remove: true }],
        undo_words: 'stops Crads-AI reading the bot, then switches your own program back on.',
      });
    }
  }
  if (envFiles.length && (!tg || envFiles.length > 1)) {
    add({ id: 'note-env-files', kind: 'note', side: 'container', title: 'Your settings files stay where they are',
      what: `${envFiles.join(', ')} stay${envFiles.length === 1 ? 's' : ''} in your brain folder. Scripts moved in can use ${envFiles.length === 1 ? 'it' : 'them'} as they did on the server.`,
      why: 'They are already in the never-commit list; moving them into secrets/ is optional.' });
  }

  // ---- skills -------------------------------------------------------------------------------------
  const theirs = (Array.isArray(inv.skills) ? inv.skills : []).map(String);
  const lazy = (Array.isArray(inv.lazy_skills) ? inv.lazy_skills : []).map(String);
  const clash = engineNames.filter((n) => theirs.includes(n));
  const fresh = engineNames.filter((n) => !theirs.includes(n) && n !== 'move-in');
  if (theirs.length || lazy.length || engineNames.length) {
    // On an adopted brain EVERY engine skill installs as crads-<name>, so none can
    // land in the person's tracked .claude/skills/ under a name they might use;
    // move-in keeps its own name unless the person has a move-in of their own.
    const own = (n) => (n === 'move-in' && !theirs.includes('move-in') ? 'move-in' : `crads-${n}`);
    const ours = engineNames.filter((n) => n !== 'move-in').map(own);
    const sid = add({ id: 'note-skills', kind: 'note', side: 'container', title: 'Your skills stay yours',
      what: sentences(`Your ${theirs.length} skill${theirs.length === 1 ? '' : 's'}${lazy.length ? ` (and ${lazy.length} in _lazy/)` : ''} stay exactly as they are; Crads-AI never writes into them`,
        ours.length && `Crads-AI's own skills install beside yours with crads- in front of their names (${ours.join(', ')}), so none of them can take a name of yours`),
      why: sentences(engineNames.includes('move-in') && (theirs.includes('move-in')
        ? 'You have a move-in skill of your own, so Crads-AI\'s is /crads-move-in'
        : 'The one exception is /move-in, the skill that explains this plan, which keeps its name')),
      details: [...clash.map((n) => ({ name: n, words: `yours stays /${n}; Crads-AI's is /crads-${n}` })), ...fresh.map((n) => ({ name: own(n), words: 'a Crads-AI skill, new to this brain' }))] });
    for (const n of theirs) items.push({ ref: `skill:${n}`, display: n, to: sid });
    for (const n of lazy) items.push({ ref: `lazy:${n}`, display: n, to: sid });
  }

  // ---- CLAUDE.md -------------------------------------------------------------------------------------
  const claudeMd = rd(path.join(stateDir, 'CLAUDE.md'));
  const hasLayers = existsSync(path.join(stateDir, 'wiki', '_layers'));
  if (claudeMd != null || hasLayers) {
    // On an adopted brain the engine's STATE.md lives at .kernel/STATE.md, never at
    // the person's root.
    const offer = hasLayers ? buildBrainSection({ prefix: '', stateMd: ADOPTED_STATE_MD }) : null;
    add({ id: 'note-claude-md', kind: 'note', side: 'container', title: 'Your CLAUDE.md stays as it is',
      what: offer ? 'Crads-AI has a short "read your brain first" block it adds to new minerals. It is offered here, never written: copy it into your CLAUDE.md yourself if you want it.'
        : 'Your CLAUDE.md already tells your assistant how to read this brain, so the plan leaves it alone.',
      why: offer ? 'Your brain has wiki/_layers/, which is what the block points at.' : 'The block Crads-AI adds to new minerals points at wiki/_layers/, which this brain does not use.',
      offered_text: offer });
  }

  // ---- MCP servers ------------------------------------------------------------------------------------
  const mcpNames = (Array.isArray(inv.mcp_servers) ? inv.mcp_servers : []).map(String);
  if (mcpNames.length) {
    const mcp = (readJson(path.join(stateDir, '.mcp.json'), {}) || {}).mcpServers || {};
    const details = [];
    for (const n of mcpNames) {
      let p = mcpPlace(mcp[n], { has, inBrain, exists });
      const refs = envRefs(mcp[n]);
      // ${VAR} references are filled from the environment of whatever starts
      // the connection. On the server that is the person's own setup (for
      // example a .env their launcher loads); inside the mineral those values
      // are not there unless they are added, so say so instead of "runs".
      const missing = refs.filter((r) => !(r in process.env));
      if (p.place === 'container' && missing.length) {
        p = { place: 'settings', why: `${p.why}, but it needs ${missing.join(', ')}, which your mineral does not have yet. On your server ${missing.length === 1 ? 'that value comes' : 'those values come'} from your own setup (for example a .env file your tools load)` };
      }
      const words = { container: 'runs inside your mineral', image: 'needs something added to your mineral first', settings: 'needs a setting added to your mineral first', host: 'only runs on your server', unknown: 'could not be checked' }[p.place]
        + `: ${p.why}${p.place === 'settings' || !refs.length ? ''
          : missing.length ? `. It also needs ${missing.join(', ')}, which your mineral does not have yet`
          : `. It uses ${refs.join(', ')}, which your mineral has`}`;
      details.push({ name: n, words, place: p.place });
      if (p.place === 'host') stillOn({ id: `mcp-${slug(n, 40)}`, name: `Connection ${n}`, what: 'an MCP server', why: p.why, source: { type: 'mcp', name: n } });
    }
    const sid = add({ id: 'note-mcp', kind: 'note', side: 'container', title: 'Your connections (MCP servers)',
      what: `Your .mcp.json names ${mcpNames.length} connection${mcpNames.length === 1 ? '' : 's'}. Each one was checked from inside your mineral; nothing in .mcp.json changes.`,
      why: 'Connections that only run on your server keep working there for your own sessions; inside your mineral they show as not available.', details });
    for (const n of mcpNames) items.push({ ref: `mcp:${n}`, display: n, to: sid });
  }

  // ---- hooks ---------------------------------------------------------------------------------------------
  const hooks = (Array.isArray(inv.hooks) ? inv.hooks : []).map(String);
  if (hooks.length) {
    const details = hooks.map((h) => {
      const rel = h.includes('/') ? h : `.claude/hooks/${h}`;
      const text = rd(path.join(stateDir, rel));
      const interp = hookInterpreter(rel, text ? text.split('\n')[0] : '');
      const ok = interp ? has(interp) : false;
      return { name: h, words: interp ? (ok ? `runs inside your mineral (${interp} is there)` : `needs ${interp}, which your mineral does not have, so it will not run there; it is left as it is`) : 'the plan could not tell what runs it; it is left as it is', place: ok ? 'container' : 'host' };
    });
    const sid = add({ id: 'note-hooks', kind: 'note', side: 'container', title: 'Your hooks stay as they are',
      what: `${hooks.length} hook${hooks.length === 1 ? '' : 's'} in .claude/hooks/ were checked for what runs them inside your mineral. None is changed or removed.`,
      why: details.some((d) => d.place === 'host') ? 'A hook that cannot run inside your mineral keeps working in your own sessions on the server.' : '', details });
    for (const h of hooks) items.push({ ref: `hook:${h}`, display: h, to: sid });
  }

  // ---- backups and git ----------------------------------------------------------------------------------------
  if (existsSync(path.join(stateDir, 'backups'))) {
    add({ id: 'note-backups', kind: 'note', side: 'container', title: 'Your backups folder stays untouched',
      what: 'Crads-AI writes its own nightly backup into backups/crads/; everything else in backups/ is yours and is never touched.',
      why: 'A host backup job is switched over only after one Crads-AI backup has been restored as a test.' });
  }
  if (git) {
    const dirty = Number(git.dirty) || 0;
    add({ id: 'note-git', kind: 'note', side: 'container', title: 'Your repository and branch are kept',
      what: sentences(`Crads-AI's nightly push uses your branch${git.branch ? ` (${git.branch})` : ''}${git.remote ? ` and your remote (${redact(git.remote)})` : ''}, as they are`,
        routed && `From inside your mineral it reaches that remote over HTTPS (${redact(routed)}), a way in of its own; your server's settings for it are unchanged`),
      why: sentences(dirty && `There ${dirty === 1 ? 'is 1 change' : `are ${dirty} changes`} not committed yet. Crads-AI never commits those: it commits only what its own jobs write, and pushes the commits already there`,
        'If someone else pushes to the same branch, Crads-AI stops and says so on the Health page instead of overwriting') });
    if (remoteBlock) {
      const backups = steps.filter((x) => x.hold && x.kind === 'cutover').map((x) => x.title);
      add({ id: 'note-git-remote', kind: 'note', side: 'container', title: 'Connect GitHub so Crads-AI can back up',
        what: sentences(`Your brain pushes to ${redact(git.remote)} (${redact(remoteUrl)}), and ${reach.why}`,
          'Crads-AI\'s nightly backup push runs inside your mineral, so it cannot use that. Connect GitHub from the app (Connect GitHub) to give it its own way in',
          'Until then, Crads-AI\'s nightly push stops and says so on the Health page, and your own backup job keeps running on the server'),
        why: sentences(backups.length ? `${backups.join(', ')} waits until GitHub is connected, so your brain is never left without a backup` : 'Nothing switches your own backup off before then',
          'After connecting, make the plan again'),
        remote: { name: String(git.remote), kind: reach.kind } });
    }
    // Engine files that would otherwise be committed into a tracked cockpit/.
    const gi = rd(path.join(stateDir, '.gitignore')) || '';
    const lines = new Set(gi.split('\n').map((l) => l.trim()));
    const whole = ['cockpit', 'cockpit/', '/cockpit', '/cockpit/'].some((x) => lines.has(x));
    const missing = whole ? [] : ENGINE_COCKPIT_FILES.filter((f) => !lines.has(f) && !lines.has('/' + f));
    if (missing.length) {
      add({ id: 'gitignore', kind: 'gitignore', side: 'container', title: 'Keep Crads-AI\'s own logs out of your repository',
        what: `Adds ${missing.length} line${missing.length === 1 ? '' : 's'} to your .gitignore for files Crads-AI writes into cockpit/ (its run log, push log and similar), so they are not committed with your work.`,
        why: 'Your brain keeps cockpit/ in git, and Crads-AI writes its running records there.', lines: missing,
        changes: [{ file: '.gitignore', append: missing }], undo_words: 'puts your .gitignore back exactly as it was.' });
    }
  }

  // ---- keep what the person already decided ------------------------------------------------------------------
  const merged = steps.map((s) => {
    const p = priorSteps.get(s.id);
    if (!p || p.state === 'pending') return s;
    return { ...s, state: p.state, undo: p.undo || [], approved_at: p.approved_at, done_at: p.done_at, done_seq: p.done_seq, result: p.result };
  });
  for (const p of priorSteps.values()) {
    if (!merged.some((s) => s.id === p.id) && p.state !== 'pending') merged.push(p);   // work already done is never forgotten
  }
  return {
    version: 1,
    generated_at: nowIso,
    inventory_collected_at: inv.collected_at || null,
    brain_root: brainRoot,
    login,
    // read by engine/cron/scripts.mjs recordedEnvFiles(): the person's own env files
    env_files: envFiles.map((f) => path.join(stateDir, f)),
    new_files: NEW_FILES,
    seq: (prior && prior.seq) || 0,
    // when the move-in began: Move out lists Crads-AI's commits since then
    started_at: (prior && prior.started_at) || inv.collected_at || nowIso,
    telegram: tgInfo,
    still_on_server: still,
    items,
    steps: merged,
  };
}

export function planNow(stateDir, opts = {}) {
  const inv = readInventory(stateDir);
  if (!inv) return { ok: false, error: 'there is no server inventory yet (.kernel/move-in/host-inventory.json); the app writes it while it sets the server up' };
  return withLock(stateDir, () => {
    const plan = buildPlan(stateDir, inv, { ...opts, prior: readPlan(stateDir) });
    // a step already done keeps its own telegram truth
    const cut = plan.steps.find((s) => s.id === 'telegram-cutover');
    const carry = plan.steps.find((s) => s.id === 'telegram-carry');
    plan.telegram.carried = !!(carry && carry.state === 'done');
    plan.telegram.answered_by = cut && cut.state === 'done' ? 'crads' : 'host';
    savePlan(stateDir, plan);
    return { ok: true, plan };
  });
}

export function summary(plan) {
  const by = (k) => plan.steps.filter((s) => s.state === k).length;
  return { steps: plan.steps.length, pending: by('pending'), approved: by('approved'), done: by('done'), skipped: by('skipped'), undone: by('undone'), still_on_server: plan.still_on_server.length };
}

if (isMain(import.meta.url)) {
  const stateDir = path.resolve(process.argv[2] || '/state');
  try {
    const r = planNow(stateDir);
    if (!r.ok) {
      console.log(`ERROR: ${r.error}`);
      process.exitCode = 1;
    } else {
      console.log('MOVEIN_PLAN ' + JSON.stringify(summary(r.plan)));
      console.log(`OK: the plan is in ${path.join(stateDir, 'move-in.md')} and on the app's Move in page.`);
    }
  } catch (e) {
    console.log(`ERROR: ${e.message || e}`);
    process.exitCode = 1;   // never process.exit(): see apply.mjs (answers cut at 64 KB)
  }
}
