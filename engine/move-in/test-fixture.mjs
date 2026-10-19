// fixture.mjs: a made-up adopted server for the /move-in tests (spec T3).
// Hand-built: every name, path, token and time here is invented, and nothing
// is read from any real server or brain. The shape follows the spec's
// description of a busy server: Claude jobs straight from cron and through a
// job runner, plain node scripts, a backup, an @reboot bridge, a Telegram
// service, two unrelated containers, an .mcp.json and skills that clash with
// the engine's.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AS_ROOT } from './host-ops.mjs';

export const BRAIN = '/home/fixture/brain';
export const LOGIN = 'fixture';
export const BOT_TOKEN = '123456789:AAFixtureTokenNotRealXXXXXXXXXXXXXXX';
export const CHAT_ID = '987654321';

export const CRON = [
  'SHELL=/bin/bash',
  'PATH=/usr/local/bin:/usr/bin:/bin',
  '# the fixture crontab',
  `@reboot cd ${BRAIN}/bridge && ./whatsapp-bridge >> /home/fixture/logs/bridge.log 2>&1`,
  `0 7 * * * cd ${BRAIN} && claude -p "/morning" --dangerously-skip-permissions >> cockpit/logs/morning.log 2>&1`,
  `30 18 * * 1-5 cd ${BRAIN} && claude -p "Write the evening digest from today's notes" >/dev/null 2>&1`,
  `10 * * * * cd ${BRAIN} && /usr/bin/node cockpit/run-job.mjs email-watcher >> cockpit/logs/jobs.log 2>&1`,
  `*/15 * * * * cd ${BRAIN} && node cockpit/run-job.mjs brief-card >> cockpit/logs/jobs.log 2>&1`,
  // Claude jobs whose prompt the runner builds when it runs (a function, a template)
  `0 17 * * 0 cd ${BRAIN} && node cockpit/run-job.mjs weekly >> cockpit/logs/jobs.log 2>&1`,
  `0 18 * * * cd ${BRAIN} && node cockpit/run-job.mjs evening-check >> cockpit/logs/jobs.log 2>&1`,
  // a prompt the shell puts together
  `0 9 * * 1 cd ${BRAIN} && claude -p "$(cat prompts/standup.txt)" >> cockpit/logs/standup.log 2>&1`,
  `*/5 * * * * /home/fixture/.nvm/versions/node/v22.11.0/bin/node ${BRAIN}/cockpit/tools/money-state.mjs`,
  `0 3 * * * cd ${BRAIN} && bash vps/backup.sh`,
  '15 6 * * * /home/fixture/go/bin/gws-watchdog --check',
  `0 */6 * * * cd ${BRAIN} && node cockpit/tools/disk-guard.mjs | tee -a /tmp/disk-guard.log`,
  `45 23 * * * cd ${BRAIN} && node cockpit/tools/nightly-tidy.mjs`,
  `45 23 * * * cd ${BRAIN} && node cockpit/tools/nightly-tidy.mjs`,
];
export const crontabText = () => CRON.join('\n') + '\n';

export function inventory() {
  return {
    version: 1,
    collected_at: '2026-10-18T09:00:00.000Z',
    login: LOGIN,
    brain_root: BRAIN,
    owner: { uid: 1000, gid: 1000 },
    crontab: CRON.map((text, i) => ({ user: LOGIN, line_no: i + 1, text })),
    units: [
      { name: 'telegram-chat.service', scope: 'system', working_directory: BRAIN, exec_start: `/usr/bin/node ${BRAIN}/cockpit/telegram-chat.mjs`, active: true },
      { name: 'cloudflared.service', scope: 'system', working_directory: '/', exec_start: '/usr/bin/cloudflared tunnel run cockpit', active: true },
    ],
    containers: [
      { name: 'cockpit', image: 'fixture/cockpit:latest', status: 'Up 6 weeks' },
      { name: 'metabase', image: 'metabase/metabase:v0.50', status: 'Up 2 days' },
    ],
    listeners: ['0.0.0.0:8080', '0.0.0.0:8898'],
    skills: ['capture', 'daily', 'followup', 'inbox', 'weekly', 'morning'],
    lazy_skills: ['lint'],
    hooks: ['guard.py', 'stamp.sh'],
    mcp_servers: ['google_workspace', 'whatsapp', 'todoist', 'files'],
    env_files: ['vps/.env'],
    git: { branch: 'master', remote: 'git@github.com:fixture/brain.git', dirty: 2 },
  };
}

const JOBS = `// jobs.mjs: what run-job.mjs can run
export const JOBS = {
  'email-watcher': {
    prompt: 'Check the inbox for anything urgent and send me a one-line summary.',
    grants: ['gmail'],
  },
  'brief-card': {
    script: 'cockpit/tools/brief-card.mjs',
  },
  weekly: {
    prompt: (ctx) => \`Write the weekly review for the week ending \${ctx.date}.\`,
  },
  'evening-check': {
    prompt: \`Check today's loose ends for \${new Date().toISOString().slice(0, 10)}.\`,
  },
};
`;

// The brain as the container sees it at <stateDir>.
export function makeBrain(stateDir, { inv = inventory() } = {}) {
  const w = (rel, text, mode) => {
    const f = path.join(stateDir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, text, mode != null ? { mode } : undefined);
  };
  w('CLAUDE.md', '# Fixture brain\n\nRead notes/ first.\n');
  w('.gitignore', '.env\nsecrets/\n.kernel/\n');
  w('ownership.json', JSON.stringify({ mineral_id: 'min_0123456789abcdef01234567', adopted: true, moving_in: true }, null, 2) + '\n');
  for (const s of inv.skills) w(`.claude/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: the fixture's own ${s}\n---\nSENTINEL ${s}\n`);
  w('.claude/skills/_lazy/lint/SKILL.md', '---\nname: lint\n---\n');
  w('.claude/hooks/guard.py', '#!/usr/bin/env python3\nprint("ok")\n');
  w('.claude/hooks/stamp.sh', '#!/bin/bash\necho ok\n');
  w('.mcp.json', JSON.stringify({ mcpServers: {
    google_workspace: { command: 'uvx', args: ['workspace-mcp'], env: { GOOGLE_CLIENT_ID: '${GOOGLE_CLIENT_ID}' } },
    whatsapp: { command: '/home/fixture/go/bin/whatsapp-mcp' },
    todoist: { type: 'http', url: 'https://ai.todoist.net/mcp' },
    files: { command: 'node', args: [`${BRAIN}/tools/mcp-files.mjs`] },
  } }, null, 2) + '\n');
  w('vps/.env', `# fixture settings\nTELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nTELEGRAM_CHAT_ID=${CHAT_ID}\nOTHER=1\n`);
  w('vps/backup.sh', '#!/bin/bash\n# Encrypted snapshot of the fixture brain\necho backed up\n', 0o755);
  w('cockpit/run-job.mjs', '// run-job.mjs: the fixture job runner\nconsole.log(process.argv[2]);\n');
  w('cockpit/jobs.mjs', JOBS);
  w('cockpit/tools/money-state.mjs', '// Rebuilds money.json from the bank export\nconsole.log("money ok");\n');
  w('cockpit/tools/disk-guard.mjs', '// Warns when the disk is nearly full\nconsole.log("disk ok");\n');
  w('cockpit/tools/nightly-tidy.mjs', '// Tidies yesterday\'s scratch files\nconsole.log("tidy ok");\n');
  w('cockpit/tools/brief-card.mjs', '// Builds the morning brief card\n');
  w('cockpit/telegram-chat.mjs', '// the fixture Telegram reader\nbot.sendVoice(chat, ogg);\nconst kb = { inline_keyboard: [[{ text: "Approve" }]] };\n');
  w('backups/.keep', '');
  w('.kernel/move-in/host-inventory.json', JSON.stringify(inv, null, 2) + '\n');
  return stateDir;
}

// What the test container has on PATH (no uvx, no gws-watchdog, no whatsapp-mcp).
export const CONTAINER_HAS = new Set(['node', 'bash', 'sh', 'env', 'python3', 'claude', 'git']);
export const has = (n) => CONTAINER_HAS.has(String(n).split('/').pop()) && !String(n).includes('/');

// ---- the fake server ----------------------------------------------------------------
// A JS object holding a crontab and services. It reads the scripts host-ops.mjs
// sends and answers the way bash would, WITHOUT executing a line: the tests run
// on real machines, and a fake that shells out could reach a real crontab.
export function fakeServer({ crontab = { [LOGIN]: crontabText() }, units = { 'telegram-chat.service': { enabled: 'enabled', active: 'active' } } } = {}) {
  const calls = [];
  const lits = (s) => Object.fromEntries([...s.matchAll(/(\w+)="\$\(printf %s '([A-Za-z0-9+/=]*)' \| base64 -d\)"/g)]
    .map((m) => [m[1], Buffer.from(m[2], 'base64').toString('utf8')]));
  const sha = (t) => createHash('sha256').update(t ?? '', 'utf8').digest('hex');
  const ssh = async (command, input) => {
    calls.push({ command, input });
    if (command !== AS_ROOT) throw new Error('every server op runs the fixed root door, with its script on stdin');
    const v = lits(input);
    if (/echo "CRONTAB/.test(input)) return { code: 0, stdout: `CRONTAB ${Buffer.from(crontab[v.U] ?? '', 'utf8').toString('base64')}\n`, stderr: '' };
    if (/crontab -u "\$U" -/.test(input)) {
      const want = input.match(/\[ "\$CUR" = "([0-9a-f]{64})" \]/)[1];
      if (sha(crontab[v.U]) !== want) return { code: 4, stdout: 'MOVEIN_ERR the crontab changed while the app was reading it, so nothing was written\n', stderr: '' };
      crontab[v.U] = Buffer.from(input.match(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d \| crontab/)[1], 'base64').toString('utf8');
      return { code: 0, stdout: `WROTE ${sha(crontab[v.U])}\n`, stderr: '' };
    }
    if (/^sysd\(\)\{/m.test(input)) {
      const u = units[v.N];
      if (!u) return { code: 5, stdout: `MOVEIN_ERR systemd would not switch ${v.N} off\n`, stderr: '' };
      if (/echo "STATE/.test(input)) return { code: 0, stdout: `STATE ${u.enabled} ${u.active}\n`, stderr: '' };   // the read-only check
      if (/echo "PRIOR/.test(input)) {
        const prior = `PRIOR ${u.enabled} ${u.active}`;
        u.enabled = 'disabled'; u.active = 'inactive';
        return { code: 0, stdout: `${prior}\nDONE inactive\n`, stderr: '' };
      }
      if (/^(enabled|enabled-runtime)$/.test(v.PE)) u.enabled = 'enabled';
      if (/^(active|activating|reloading)$/.test(v.PA)) u.active = 'active';
      return { code: 0, stdout: `DONE ${u.active}\n`, stderr: '' };
    }
    throw new Error('the fake server was sent something that is neither of the two ops');
  };
  return { host: { ssh }, calls, crontab, units };
}

