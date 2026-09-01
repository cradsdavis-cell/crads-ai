// p1-drive.mjs: headless proof the one-shell cutover works on BOTH faces.
// Boots the fixture harness, then drives /panel (org) and /member with real
// clicks and asserts visibility, section activation and zero console errors.
// Uses the sibling checkout's gitignored playwright install (same pattern as
// the qa-* tests: never a committed dependency).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require2 = createRequire(new URL('./node_modules/', import.meta.url));
const { chromium } = require2('playwright');

const PORT = 4701;
const harness = spawn(process.execPath, [new URL('./harness.mjs', import.meta.url).pathname, '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

const errs = [];
const browser = await chromium.launch();
const ctx = await browser.newContext();
const checks = [];
function ok(name, cond) { checks.push([name, !!cond]); if (!cond) process.exitCode = 1; }

// ---- org face ----
const org = await ctx.newPage();
org.on('console', (m) => { if (m.type() === 'error') errs.push('org: ' + m.text()); });
org.on('pageerror', (e) => errs.push('org pageerror: ' + e.message));
await org.goto(`http://127.0.0.1:${PORT}/panel`, { waitUntil: 'networkidle' });
ok('org: body stamped org', await org.getAttribute('body', 'data-edition') === 'org');
ok('org: Your rock tab visible', await org.isVisible('#navYourrock'));
ok('org: Decisions tab visible', await org.isVisible('button[data-sec="decisions"]'));
ok('org: Decisions rides second in the nav', await org.evaluate(() => {
  const btns = [...document.querySelectorAll('#nav > button')].filter((b) => b.offsetParent !== null);
  return btns[1] && btns[1].dataset.sec === 'decisions';
}));
ok('org: nav-foot shortcut gone', !(await org.isVisible('#setupLink')));
ok('org: member seat tab hidden', !(await org.isVisible('button[data-sec="seat"]')));
ok('org: Your assistant group shared since P2', await org.isVisible('[data-group="assistant"] .ghead'));
ok('org: brand lockup visible', await org.isVisible('aside .brand'));
ok('org: white-label blurb hidden', !(await org.isVisible('aside .foot')));
// Network group: open it, only Pebbles inside
await org.click('button[data-group-toggle="network"]');
ok('org: Pebbles item visible in Network group', await org.isVisible('button[data-sec="pebbles"]'));
ok('org: Map item shared since P3b', await org.isVisible('#grp-network button[data-sec="network"]'));
await org.click('button[data-sec="pebbles"]');
await org.waitForTimeout(600);
ok('org: pebbles section active', await org.isVisible('section[data-sec="pebbles"].active'));
ok('org: fleet summary or cards or empty rendered', await org.isVisible('#fleetSummary') || await org.isVisible('.fleet-card') || await org.isVisible('#fleetEmpty'));
ok('org: stamp fold lives on Pebbles now', await org.isVisible('#stampFold'));
// the staged flow: details hidden until whose-pebble is answered, button armed only when filled
await org.evaluate(() => { document.getElementById('stampFold').open = true; });
ok('org: details hidden before the ownership pick', !(await org.isVisible('#stDetails')));
await org.click('#stOwnMember');
ok('org: details revealed by the pick', await org.isVisible('#stDetails'));
ok('org: create disabled until filled', await org.evaluate(() => document.getElementById('stampBtn').disabled));
await org.fill('#st_name', 'Probe Person');
await org.fill('#st_email', 'probe@gmail.com');
ok('org: create arms once filled', await org.evaluate(() => !document.getElementById('stampBtn').disabled));
ok('org: provider inferred from the address', (await org.textContent('#stProviderLine')).includes('Google'));
await org.evaluate(() => { document.getElementById('st_name').value = ''; document.getElementById('st_email').value = ''; document.getElementById('st_name').dispatchEvent(new Event('input')); document.getElementById('stampFold').open = false; });
ok('org: member card carries a Manage fold', (await org.locator('.fleet-card details.cardfold').count()) > 0 || (await org.locator('.fleet-card').count()) === 0);
ok('org: no Operators tab', !(await org.isVisible('button[data-sec="operators"]')));
await org.click('button[data-sec="decisions"]');
await org.waitForTimeout(400);
ok('org: decisions section active', await org.isVisible('section[data-sec="decisions"].active'));
// 2026-08-09 cleanup: Decisions is a pure queue — the forms left
ok('org: no stamp form on Decisions', !(await org.isVisible('section[data-sec="decisions"] #stampBtn')));
ok('org: queue empty state honest', await org.isVisible('#attnEmpty') || await org.isVisible('#joinReqCard') || await org.isVisible('#rockTieCard'));
await org.click('#navYourrock');
await org.waitForTimeout(600);
ok('org: yourrock section active', await org.isVisible('section[data-sec="yourrock"].active'));
ok('org: identity card drawn', await org.isVisible('#rockIdCard'));
ok('org: custody card drawn', await org.isVisible('#rockCustodyCard'));
// Access moved to the account pages (2026-08-14): the app does not originate
// invitations and keeps no second copy of who can reach the rock.
ok('org: admin card is DEAD (access is an account-page concept)', !(await org.isVisible('#rockAdminCard')));
ok('org: Rules form is DEAD (second loop)', !(await org.isVisible('#govForm')));
ok('org: find-this-rock card lives here now', await org.isVisible('#commCard'));
ok('org: rename control present', await org.isVisible('#ridRenameBtn'));
ok('org: no global teardown in Danger', !(await org.isVisible('#dzBtn')));
ok('org: dead gov fields trimmed', !(await org.isVisible('[data-key="access.browser_fallback"]')) && !(await org.isVisible('[data-key="roles.support"]')) && !(await org.isVisible('[data-key="region"]')));
// P2: the self-management pages are shared — Automations opens for the org too
await org.click('button[data-group-toggle="assistant"]');
ok('org: Skills visible in Your assistant', await org.isVisible('#grp-assistant button[data-sec="skills"]'));
ok('org: Library hidden in Your assistant', !(await org.isVisible('#grp-assistant button[data-sec="library"]')));
await org.click('#grp-assistant button[data-sec="skills"]');
await org.waitForTimeout(500);
ok('org: skills section activates', await org.isVisible('section[data-sec="skills"].active'));
await org.click('button[data-group-toggle="privacy"]');
ok('org: Sharing visible in Privacy', await org.isVisible('#grp-privacy button[data-sec="sharing"]'));
await org.click('#grp-privacy button[data-sec="sharing"]');
await org.waitForTimeout(500);
ok('org: sharing section activates', await org.isVisible('section[data-sec="sharing"].active'));
ok('org: platform floor card visible', await org.isVisible('section[data-sec="sharing"] .guidecard.orgonly'));
ok('org: Help link visible', await org.isVisible('#helpLink'));
// member-only wall still holds where it should
await org.evaluate(() => { location.hash = '#seat'; });
await org.waitForTimeout(300);
ok('org: #seat deep link refused', !(await org.isVisible('section[data-sec="seat"].active')));
// P3: the Rocks tab is shared; the org face carries the rehomed console surfaces
// (the network group is already open from the Pebbles checks above)
ok('org: Rocks visible in Network group', await org.isVisible('#grp-network button[data-sec="rocks"]'));
await org.click('#grp-network button[data-sec="rocks"]');
await org.waitForTimeout(600);
ok('org: rocks section activates', await org.isVisible('section[data-sec="rocks"].active'));
ok('org: no door card on Rocks (moved to Your rock)', !(await org.isVisible('section[data-sec="rocks"] #commCard')));
ok('org: no New-Rock form anywhere (rocks cannot create rocks)', !(await org.isVisible('#rockBtn')));
ok('org: asks-between-rocks card present', await org.isVisible('#rqRows') || await org.isVisible('#rqEmpty'));
ok('org: composer present', await org.isVisible('#askSend'));
ok('org: no anchor-ask on the board', !(await org.isVisible('[data-rock-anchor]')));
ok('org: no console button anywhere', !(await org.isVisible('#navConsole')));
// P3b: the rock Map — fleet shelf below, anchor above, truthful captions
await org.click('#grp-network button[data-sec="network"]');
await org.waitForTimeout(2500);
ok('org: map section activates', await org.isVisible('section[data-sec="network"].active'));
ok('org: rock you-card drawn', await org.isVisible('#netMap .nyou'));
ok('org: anchor card above (Crads AI)', (await org.textContent('#netMap .norg').catch(() => '')).includes('Crads AI'));
ok('org: fleet chips drawn', (await org.locator('#netMap .nfl').count()) >= 3);
ok('org: joined affiliate draws dashed', await org.isVisible('#netMap .nfl.njoined'));
ok('org: anchored caption is registry truth, never reach', ((await org.getAttribute('#netMap .nfl[data-fleet-slug="jane01"]', 'title', { timeout: 3000 }).catch(() => '')) || '').includes('anchored here'));

// ---- member face (fresh context: localStorage must not leak the org page's
// open-group state, or the toggle click below would CLOSE an already-open group) ----
const ctx2 = await browser.newContext();
const mem = await ctx2.newPage();
mem.on('console', (m) => { if (m.type() === 'error') errs.push('member: ' + m.text()); });
mem.on('pageerror', (e) => errs.push('member pageerror: ' + e.message));
await mem.goto(`http://127.0.0.1:${PORT}/member`, { waitUntil: 'networkidle' });
ok('member: body stamped member', await mem.getAttribute('body', 'data-edition') === 'member');
ok('member: org tabs hidden', !(await mem.isVisible('#navYourrock')) && !(await mem.isVisible('button[data-sec="decisions"]')));
ok('member: no brand lockup', !(await mem.isVisible('aside .brand')));
ok('member: white-label blurb visible', await mem.isVisible('aside .foot'));
await mem.click('button[data-group-toggle="network"]');
ok('member: Map visible in group', await mem.isVisible('#grp-network button[data-sec="network"]'));
ok('member: Rocks visible in group', await mem.isVisible('#grp-network button[data-sec="rocks"]'));
ok('member: Pebbles hidden in group', !(await mem.isVisible('#grp-network button[data-sec="pebbles"]')));
await mem.click('#grp-network button[data-sec="network"]');
await mem.waitForTimeout(500);
ok('member: Map (network section) activates', await mem.isVisible('section[data-sec="network"].active'));
// deep-link wall the other way
await mem.evaluate(() => { location.hash = '#decisions'; });
await mem.waitForTimeout(300);
ok('member: #decisions deep link refused', !(await mem.isVisible('section[data-sec="decisions"].active')));
// legacy aliases still land
await mem.evaluate(() => { location.hash = '#communities'; });
await mem.waitForTimeout(300);
ok('member: #communities lands on Rocks', await mem.isVisible('section[data-sec="rocks"].active'));
// P2: member face unchanged by the sharing floor card + keeps its Library
await mem.click('button[data-group-toggle="assistant"]');
ok('member: Library visible in Your assistant', await mem.isVisible('#grp-assistant button[data-sec="library"]'));
await mem.click('button[data-group-toggle="privacy"]');
await mem.click('#grp-privacy button[data-sec="sharing"]');
await mem.waitForTimeout(400);
ok('member: no platform floor card', !(await mem.isVisible('section[data-sec="sharing"] .guidecard.orgonly')));

await browser.close();
harness.kill();

for (const [name, pass] of checks) console.log((pass ? 'PASS ' : 'FAIL ') + name);
const realErrs = errs.filter((e) => !/favicon|net::ERR/.test(e));
console.log('console errors:', realErrs.length ? realErrs.slice(0, 8) : 'none');
if (realErrs.length) process.exitCode = 1;
console.log(checks.every(c => c[1]) && !realErrs.length ? 'P1 DRIVE: ALL GREEN' : 'P1 DRIVE: FAILURES ABOVE');
