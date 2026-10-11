// team-shots.mjs: drive "Set up a team" end to end in a real browser against
// fakes (fake provider, fake GitHub, fake device flow, fake boxes) and save a
// full-page PNG per screen plus any console errors. Nothing touches the network.
//   cd wizard/dev-harness && npm i && node team-shots.mjs [out-dir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDoorServer } from '../panel/door-server.mjs';
import { fakeClient } from './provision-fixture.mjs';

const out = process.argv[2] || join(tmpdir(), 'team-shots');
mkdirSync(out, { recursive: true });
const sshDir = join(out, 'ssh');
rmSync(sshDir, { recursive: true, force: true });   // a left-over team file would resume, not build
const calls = [];
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@door';
let approve;
const approved = new Promise((r) => { approve = r; });
const slow = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createDoorServer({
  bridge: { targets: () => [], stream: () => { throw new Error('no ssh in shots'); }, tty: () => null },
  probe: async () => ({ code: 1, stdout: '', stderr: '' }),
  provision: { sshDir, makeClient: (t, p) => fakeClient(calls, p), settingsPath: join(out, 'claude.json') },
  team: {
    sshDir,
    settingsPath: join(out, 'claude.json'),
    makeClient: (t, p) => fakeClient(calls, p),
    github: () => ({
      whoami: async () => 'acme-owner',
      ensureRepo: async () => { await slow(300); return { created: true }; },
      ensureFile: async () => ({ created: true }),
      ensureDeployKey: async () => ({ added: true }),
      removeDeployKeys: async () => ({ removed: 1 }),
      archiveRepo: async () => ({ archived: true }),
    }),
    exportDir: join(out, 'exports'),
    destroy: async () => ({ destroyed: true }),
    forget: () => {},
    deviceFlow: async () => ({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', poll: async () => { await approved; return { ok: true, token: 'gho_fake' }; } }),
    exec: async (alias, cmd) => {
      await slow(200);
      if (/ keys \/state /.test(cmd)) {
        const names = cmd.split(' keys /state ')[1].trim().split(' ');
        return { code: 0, stdout: `TEAM_KEYS ${JSON.stringify(Object.fromEntries(names.map((n) => [n, `ssh-ed25519 K-${n}`])))}\n` };
      }
      if (/tar czf - personal/.test(cmd)) return { code: 0, stdout: Buffer.from('personal-folder').toString('base64') + '\n' };
      return { code: 0, stdout: 'TEAM_ENROLLED {}\n' };
    },
    install: () => ({ publicKey: PUB + '\n' }),
    pin: () => {}, register: () => {}, openFolder: async () => ({ code: 1 }),
    probe: async () => { await slow(2500); return { code: 0, stdout: 'chain-ok\n' }; },
    sleep: slow, bootTimeoutMs: 5000, bootPollMs: 100,
  },
});
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });

await page.goto(base + '/');
await page.waitForSelector('[data-make="team"]', { state: 'visible' });
await shot('1-doors');
await page.click('[data-make="team"]');
await page.waitForSelector('#tmIntro', { state: 'visible' });
await shot('2-intro');
await page.click('#tmIntroOk');
await page.fill('#tmCompany', 'acme');
await page.fill('#tmPeople', 'Jess Smith\nTom Lee');
await page.fill('#tmToken', 'fixture-token');
await page.click('#tmCheckBtn');
await page.waitForSelector('#tmBuildBtn', { state: 'visible' });
await shot('3-form');
await page.click('#tmBuildBtn');
await page.waitForSelector('#tmGh', { state: 'visible' });
await shot('4-github-code');
approve();
try {
  await page.waitForFunction(() => /First boot|Creating the server/.test(document.getElementById('tmBoxes').textContent), null, { timeout: 15000 });
  await shot('5-building');
} catch (e) {
  await shot('5-stuck');
  console.log('STUCK', JSON.stringify(await (await fetch(base + '/team/status')).json()));
  throw e;
}
await page.waitForSelector('#tmDone', { state: 'visible', timeout: 60000 });
await shot('6-done');
const doneText = await page.textContent('#tmDone');
// ---- stage 3: the manage screen, add a person, someone's leaving
await page.goto(base + '/');
await page.waitForSelector('[data-make="team"]:visible, #newTeam:visible');
if (await page.isVisible('[data-make="team"]')) await page.click('[data-make="team"]'); else await page.click('#newTeam');
await page.waitForSelector('#tmManage', { state: 'visible' });
await shot('7-manage');
await page.click('[data-tm-add="0"]');
await page.fill('#tmAddPeople', 'Ana Ruiz');
await page.fill('#tmAddToken', 'fixture-token');
await shot('8-add-form');
await page.click('#tmAddBtn');
await page.waitForSelector('#tmDone', { state: 'visible', timeout: 60000 });
await shot('9-added');
const addedText = await page.textContent('#tmDone');
await page.goto(base + '/');
await page.waitForSelector('[data-make="team"]:visible, #newTeam:visible');
if (await page.isVisible('[data-make="team"]')) await page.click('[data-make="team"]'); else await page.click('#newTeam');
await page.waitForSelector('#tmManage', { state: 'visible' });
await page.click('[data-tm-leave="0"]');
await page.selectOption('#tmLeavePerson', 'tom');
await page.dispatchEvent('#tmLeavePerson', 'change');
await page.fill('#tmLeaveConfirm', 'Tom');
await page.fill('#tmLeaveToken', 'fixture-token');
await page.click('#tmLeaveBtn');
await page.waitForSelector('#tmMsg.on', { timeout: 5000 });
const refused = await page.textContent('#tmMsg');
await page.fill('#tmLeaveConfirm', 'Tom Lee');
await shot('10-leave-form');
await page.click('#tmLeaveBtn');
await page.waitForSelector('#tmDone', { state: 'visible', timeout: 60000 });
await shot('11-left');
const leftText = await page.textContent('#tmDone');
writeFileSync(join(out, 'console-errors.json'), JSON.stringify(errors, null, 2));
console.log(JSON.stringify({ out, errors, servers: calls.filter((c) => c[0] === 'create').map((c) => c[1]), doneHasHandover: /I already have one/.test(doneText),
  addedOnlyAna: /Ana Ruiz/.test(addedText) && !/Tom Lee/.test(addedText), refused, left: leftText.replace(/\s+/g, ' ').trim() }));
await browser.close();
server.close();
