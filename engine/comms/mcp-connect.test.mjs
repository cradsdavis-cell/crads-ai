// mcp-connect.test.mjs — run: node --test engine/comms/mcp-connect.test.mjs
//
// The state machine behind the app's Connections page, reworked 2026-08-09 after
// Sam's ruling: no walled garden. Featured = only servers whose sign-in verifiably
// completes with zero secrets (DCR); anything else connects by URL, with an
// optional API token. Google (2026-08-17 ruling): ONE row, connected with the
// member's OWN OAuth client via the app's wizard — docs/design-google-byo-connect.md.
// The three old "not yet" cards are gone; their dead-end recognition remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = path.join(import.meta.dirname, 'mcp-connect.mjs');
const TOKEN_TOOL = path.join(import.meta.dirname, 'mcp-token.mjs');
const box = () => {
  const d = tmpDir('mcpc-');
  mkdirSync(path.join(d, '.claude-auth'), { recursive: true });
  return d;
};
const run = (d, args, stdin) => JSON.parse(execFileSync('node', [SCRIPT, d, ...(Array.isArray(args) ? args : [args])], { encoding: 'utf8', input: stdin }));
const svc = (r, k) => r.services.find((s) => s.key === k);
const creds = (d, name, extra = {}) => writeFileSync(path.join(d, '.claude-auth', '.credentials.json'), JSON.stringify({
  mcpOAuth: { [`${name}|abc`]: { serverName: name, accessToken: 't', expiresAt: Date.now() + 3600e3, ...extra } },
}));
const b64 = (s) => Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
const json = (s) => JSON.stringify(s);

test('a fresh box: featured rows off, ONE google row offering the BYO key', () => {
  const r = run(box(), 'status');
  const featured = r.services.filter((s) => s.state === 'off');
  assert.ok(featured.length >= 5, 'a real featured list, not three dead ends');
  const g = svc(r, 'google');
  assert.ok(g, 'the google offer exists');
  assert.equal(g.state, 'off');
  assert.equal(g.byo, 'google', 'the page routes this press to the wizard, not a plain add');
  assert.equal(g.auth, 'byo');
  for (const k of ['gmail', 'calendar', 'drive']) {
    assert.ok(!svc(r, k), `the old "${k}" not-yet card must be gone — the google row replaced it`);
  }
});

// The box says what it can DO, so the page can tell "behind" from "broken".
// Without this the only guard was `[ -f mcp-connect.mjs ]`, which an older copy
// passes, and the member met a raw error instead of a one-click fix.
test('status reports a contract version, on every row-bearing answer', () => {
  const d = box();
  const s = run(d, 'status');
  assert.equal(typeof s.contract, 'number', 'a page cannot compare what is not there');
  assert.ok(s.contract >= 1);
  // the mutating verbs return rows too, and the page reads them the same way
  const a = run(d, ['add', 'notion']);
  assert.equal(a.contract, s.contract, 'add must not answer with a different contract');
  const r = run(d, ['remove', 'notion']);
  assert.equal(r.contract, s.contract, 'remove must not answer with a different contract');
});

test('contract 1 means what it claims: every url-authed row carries a url field', () => {
  const d = box();
  const s = run(d, 'status');
  assert.ok(s.contract >= 2, 'contract 2 = the BYO google row + add-google exist');
  for (const row of s.services.filter((x) => x.state !== 'unavailable' && x.state !== 'dead-end' && x.auth !== 'byo')) {
    assert.equal(typeof row.url, 'string', `${row.key} has no url, so contract 1 is a lie`);
  }
});

// Live on Sam's own box, 2026-08-09: Canva sat in "added, waiting for you to
// sign in once" and its Sign in button answered "bad server url" every time.
// The row's url came only from the box's .mcp.json entry, that entry carried no
// url, and the page's own fallback map is built FROM these rows, so it was empty
// too and the sign-in posted a blank url. A featured service must always report
// an address, because the catalogue knows it even when the box entry does not.
test('a featured entry with no url still reports the catalogue address', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { canva: { type: 'http' } } }));
  const s = svc(run(d, 'status'), 'canva');
  assert.equal(s.configured, true, 'it is on the box, so it is configured');
  assert.equal(s.url, 'https://mcp.canva.com/mcp', 'a blank url here is a dead Sign in button');
});

test('a featured entry keeps its OWN url when it has one', () => {
  const d = box();
  const own = 'https://mcp.canva.com/mcp?tenant=abc';
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { canva: { type: 'http', url: own } } }));
  assert.equal(svc(run(d, 'status'), 'canva').url, own, 'the catalogue must not overwrite the box');
});

test('featured add -> needs-auth -> authorised = working; expiry honest', () => {
  const d = box();
  run(d, ['add', 'notion']);
  let s = svc(run(d, 'status'), 'notion');
  assert.equal(s.state, 'needs-auth');
  assert.match(s.status, /sign in once/i);
  creds(d, 'notion', { refreshToken: 'r' });
  s = svc(run(d, 'status'), 'notion');
  assert.equal(s.state, 'on');
  assert.match(s.status, /scheduled jobs/i);
  assert.equal(s.renews, true);
  creds(d, 'notion', { expiresAt: Date.now() - 1000 });
  s = svc(run(d, 'status'), 'notion');
  assert.equal(s.state, 'needs-auth');
  assert.match(s.status, /expired/i);
});

test('the old Google dead end on an existing box is named and clearable', () => {
  // keith carries exactly this: the first catalogue wired gmail/calendar/drive
  // to googleapis endpoints where sign-in can never complete
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { gmail: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' } } }));
  const g = svc(run(d, 'status'), 'gmail');
  assert.equal(g.state, 'dead-end');
  assert.match(g.status, /can never finish/i);
  const r = run(d, ['remove', 'gmail']);
  assert.equal(r.ok, true);
  assert.ok(!svc(r, 'gmail'), 'after cleanup the dead key is simply gone — the google row is the offer now');
  assert.equal(svc(r, 'google').state, 'off');
});

test('add-custom by URL: anything https, name validated, sse detected', () => {
  const d = box();
  const r = run(d, 'add-custom', b64({ name: 'todoist', url: 'https://ai.todoist.net/mcp' }));
  assert.equal(r.ok, true);
  const mcp = JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.todoist, { type: 'http', url: 'https://ai.todoist.net/mcp' });
  assert.equal(svc(r, 'todoist').state, 'needs-auth', 'oauth until proven otherwise');

  const sse = run(d, 'add-custom', b64({ name: 'other', url: 'https://x.example.com/sse' }));
  assert.equal(JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.other.type, 'sse');

  for (const bad of [{ name: 'X', url: 'https://x.co/mcp' }, { name: 'ok', url: 'http://insecure.co' }, { name: 'ok', url: 'nonsense' }]) {
    assert.equal(run(d, 'add-custom', b64(bad)).ok, false, JSON.stringify(bad));
  }
});

test('add-custom with an API token: credentialed from birth, token never echoed', () => {
  const d = box();
  const TOKEN = 'sk-live-veryverysecret';
  const raw = execFileSync('node', [SCRIPT, d, 'add-custom'], { encoding: 'utf8', input: b64({ name: 'zap', url: 'https://mcp.zap.example/mcp', token_b64: Buffer.from(TOKEN).toString('base64') }) });
  const r = JSON.parse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.auth, 'token');
  const s = svc(r, 'zap');
  assert.equal(s.state, 'on', 'a bearer token needs no sign-in step');
  assert.equal(s.auth, 'token', 'the page can visualise HOW it authenticates');
  assert.ok(!raw.includes(TOKEN), 'the secret must not come back out through the verb');
  const mcp = JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.zap.headers.Authorization, `Bearer ${TOKEN}`);
});

test('a server added by hand in Claude Code is listed but never removable here', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { theirs: { type: 'http', url: 'https://their.example/mcp' } } }));
  const st = run(d, 'status');
  const t = svc(st, 'theirs');
  assert.equal(t.mine, false);
  assert.match(t.blurb, /added by you in Claude Code/i);
  const r = run(d, ['remove', 'theirs']);
  assert.equal(r.ok, false);
  assert.match(r.error, /not added here/i);
  // and add-custom cannot silently overwrite their definition either
  assert.equal(run(d, 'add-custom', b64({ name: 'theirs', url: 'https://mine.example/mcp' })).ok, false);
});

test('remove is scoped to what this tool added, and destroys the credential on the box (R8)', () => {
  const d = box();
  run(d, 'add-custom', b64({ name: 'todoist', url: 'https://ai.todoist.net/mcp' }));
  creds(d, 'todoist', { refreshToken: 'r' });
  const r = run(d, ['remove', 'todoist']);
  assert.equal(r.ok, true);
  assert.ok(!JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.todoist);
  // Until R8 (2026-08-23) this asserted the opposite: the grant stayed so a
  // re-add looked instantly authorised. Disconnect now has one meaning.
  const store = JSON.parse(readFileSync(path.join(d, '.claude-auth', '.credentials.json'), 'utf8'));
  assert.equal(Object.values(store.mcpOAuth || {}).some((v) => v.serverName === 'todoist'), false, 'the Claude Code token for this server is gone');
  assert.match(r.notice, /yours to revoke there/, 'the OK line says the provider-side grant is the member\'s to revoke');
});

// --- R8 (2026-08-23): Disconnect = the credential is destroyed on the box -----
test('R8: remove clears the .kernel/mcp-oauth.json entry and the bearer header, for any connector', () => {
  const d = box();
  run(d, 'add-custom', b64({ name: 'stripe', url: 'https://mcp.stripe.com', token_b64: Buffer.from('BEARER-CANARY').toString('base64') }));
  run(d, 'add', 'notion');
  // refresh material the app handed to mcp-token.mjs set
  execFileSync('node', [TOKEN_TOOL, d, 'set'], { input: b64({ name: 'notion', url: 'https://mcp.notion.com/mcp', access_token: 'AT', refresh_token: 'NOTION-REFRESH-CANARY' }) });
  const oauthF = path.join(d, '.kernel', 'mcp-oauth.json');
  assert.ok(JSON.parse(readFileSync(oauthF, 'utf8')).notion, 'precondition: the refresh entry exists');
  assert.ok(JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.stripe.headers.Authorization, 'precondition: the header exists');

  const r = run(d, ['remove', 'notion']);
  assert.equal(r.ok, true);
  const store = JSON.parse(readFileSync(oauthF, 'utf8'));
  assert.equal('notion' in store, false, 'the refresh entry is gone');
  assert.doesNotMatch(readFileSync(oauthF, 'utf8'), /NOTION-REFRESH-CANARY/);
  assert.equal(svc(r, 'notion').state, 'off');
  assert.match(r.notice, /Notion/);

  const r2 = run(d, ['remove', 'stripe']);
  assert.equal(r2.ok, true);
  assert.doesNotMatch(readFileSync(path.join(d, '.mcp.json'), 'utf8'), /BEARER-CANARY/, 'the bearer header left with its entry');
  assert.doesNotMatch(JSON.stringify(r2), /BEARER-CANARY/, 'never echoed');
});

test('R8: remove never touches the Claude sign-in beside the MCP tokens', () => {
  const d = box();
  run(d, 'add', 'notion');
  writeFileSync(path.join(d, '.claude-auth', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'SIGNIN-STAYS', refreshToken: 'SIGNIN-STAYS-2' },
    mcpOAuth: { 'notion|abc': { serverName: 'notion', accessToken: 't' }, 'linear|def': { serverName: 'linear', accessToken: 'u' } },
  }));
  run(d, ['remove', 'notion']);
  const store = JSON.parse(readFileSync(path.join(d, '.claude-auth', '.credentials.json'), 'utf8'));
  assert.equal(store.claudeAiOauth.accessToken, 'SIGNIN-STAYS');
  assert.ok(store.mcpOAuth['linear|def'], 'another connection\'s token survives');
  assert.equal('notion|abc' in store.mcpOAuth, false);
});

// Parked from the 2026-08-09 connections-directory review: add-custom deduped by
// NAME only. The directory offers a Connect card for a server it can't see is
// already wired (its hide-connected match keys off the registry url run through
// new URL().href, and the box reported the url verbatim), so a second name for
// one remote sailed through and wrote a duplicate mcpServers entry.
test('add-custom dedups by normalised endpoint: a second name for one remote is refused', () => {
  const d = box();
  // first connect, spelled bare-origin
  assert.equal(run(d, 'add-custom', b64({ name: 'acme', url: 'https://mcp.acme.example' })).ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.acme.url,
    'https://mcp.acme.example/', 'the box stores the normalised address');
  // same endpoint, different name, spelled with the trailing slash: a duplicate
  const dup = run(d, 'add-custom', b64({ name: 'acme_jobs', url: 'https://mcp.acme.example/' }));
  assert.equal(dup.ok, false, 'one remote under two names is the directory-duplicate bug');
  assert.match(dup.error, /already connected as "acme"/i);
  assert.equal(Object.keys(JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers).length, 1,
    'exactly one entry survives for the endpoint');
});

test('rows report a normalised url, so the directory matches connected endpoints', () => {
  const d = box();
  // a hand-added server spelled bare-origin must read as the trailing-slash form
  // the directory has already normalised its registry url to
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { theirs: { type: 'http', url: 'https://their.example' } } }));
  assert.equal(svc(run(d, 'status'), 'theirs').url, 'https://their.example/');
});

test('featured names cannot be shadowed through add-custom', () => {
  const d = box();
  for (const name of ['notion', 'gmail']) {
    const r = run(d, 'add-custom', b64({ name, url: 'https://evil.example/mcp' }));
    assert.equal(r.ok, false, `${name} must be refused`);
  }
});

test('operator-configured servers survive every add and remove', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { ms365: { command: 'x' } } }));
  run(d, ['add', 'notion']);
  run(d, 'add-custom', b64({ name: 'todoist', url: 'https://ai.todoist.net/mcp' }));
  run(d, ['remove', 'notion']);
  run(d, ['remove', 'todoist']);
  assert.ok(JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.ms365, 'never evicted');
});

// ---- the approval gate (2026-08-09, found live on keith) -------------------
const claudeJson = (d) => JSON.parse(readFileSync(path.join(d, '.claude-auth', '.claude.json'), 'utf8'));

test('adding a server records the approval the click already is', () => {
  const d = box();
  run(d, ['add', 'notion']);
  const proj = claudeJson(d).projects[d];
  assert.ok(proj.enabledMcpjsonServers.includes('notion'),
    'without this the CLI answers "awaiting approval. Run claude to review" and the sign-in cannot start');
  assert.equal(proj.hasTrustDialogAccepted, true);
});

test('status HEALS a box whose servers predate the approval fix', () => {
  // keith: app-added servers, no approval anywhere, no dialog to accept
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { canva: { type: 'http', url: 'https://mcp.canva.com/mcp' }, theirs: { type: 'http', url: 'https://their.example/mcp' } } }));
  mkdirSync(path.join(d, '.kernel'), { recursive: true });
  writeFileSync(path.join(d, '.kernel', 'mcp-added.json'), JSON.stringify(['canva']));
  run(d, 'status');
  const proj = claudeJson(d).projects[d];
  assert.ok(proj.enabledMcpjsonServers.includes('canva'), 'app-added servers are healed');
  assert.ok(!proj.enabledMcpjsonServers.includes('theirs'),
    'hand-added servers are NOT auto-approved: the member reviews those in the dialog themselves');
});

test('approval writes MERGE the existing config store, never replace it', () => {
  const d = box();
  writeFileSync(path.join(d, '.claude-auth', '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'member@example.com' },
    projects: { [d]: { enabledMcpjsonServers: ['already'], somePref: 7 } },
  }));
  run(d, ['add', 'notion']);
  const doc = claudeJson(d);
  assert.equal(doc.oauthAccount.emailAddress, 'member@example.com', 'the account block survives');
  const proj = doc.projects[d];
  assert.deepEqual([...proj.enabledMcpjsonServers].sort(), ['already', 'notion']);
  assert.equal(proj.somePref, 7, 'unrelated project settings survive');
});

// ---- chats-only connections (Sam's ask, 2026-08-09) ------------------------
// A default `claude mcp add` lands in LOCAL scope: visible to the member's
// interactive sessions, invisible to .mcp.json AND (verified) never loaded by
// headless runs. These must appear on the page, say honestly that jobs cannot
// see them, and adopt into project scope in one click.
const chatScope = (d, name, def, scope = 'local') => {
  const p = path.join(d, '.claude-auth', '.claude.json');
  const doc = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  if (scope === 'local') {
    doc.projects = doc.projects || {}; doc.projects[d] = doc.projects[d] || {};
    doc.projects[d].mcpServers = { ...(doc.projects[d].mcpServers || {}), [name]: def };
  } else doc.mcpServers = { ...(doc.mcpServers || {}), [name]: def };
  writeFileSync(p, JSON.stringify(doc));
};

test('a connection made inside Claude Code appears, honestly chats-only', () => {
  const d = box();
  chatScope(d, 'stripe', { type: 'http', url: 'https://mcp.stripe.example/mcp' });
  const s = svc(run(d, 'status'), 'stripe');
  assert.ok(s, 'it must not vanish from the page');
  assert.equal(s.state, 'chat-only');
  assert.match(s.status, /chats only, not in scheduled jobs/i);
  assert.equal(s.adoptable, true);
  assert.match(s.blurb, /connected in Claude Code/i);
});

test('adopt moves it where jobs load it, keeps the sign-in, cleans the source', () => {
  const d = box();
  chatScope(d, 'stripe', { type: 'http', url: 'https://mcp.stripe.example/mcp' });
  creds(d, 'stripe', { refreshToken: 'r' });
  const r = run(d, ['adopt', 'stripe']);
  assert.equal(r.ok, true);
  const mcp = JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.stripe.url, 'https://mcp.stripe.example/mcp', 'the MEMBER\'s definition moves, verbatim');
  const cj = JSON.parse(readFileSync(path.join(d, '.claude-auth', '.claude.json'), 'utf8'));
  assert.ok(!cj.projects[d].mcpServers.stripe, 'source removed: local scope would shadow project scope');
  assert.ok(cj.projects[d].enabledMcpjsonServers.includes('stripe'), 'approval recorded');
  const s = svc(r, 'stripe');
  assert.equal(s.state, 'on', 'the existing sign-in survives the move (store is keyed by name+url)');
});

test('a project-scope server shadowped by name is not double-listed, and adopt refuses', () => {
  const d = box();
  run(d, ['add', 'notion']);
  chatScope(d, 'notion', { type: 'http', url: 'https://mcp.notion.com/mcp' });
  const r = run(d, 'status');
  assert.equal(r.services.filter((x) => x.key === 'notion').length, 1, 'one row per name');
  assert.equal(run(d, ['adopt', 'notion']).ok, false, 'already set up for jobs');
});

test('add-custom will not duplicate a Claude Code connection under a directory name', () => {
  // the exact net-effect the review parked: a server already connected in Claude
  // Code (chats-only) whose endpoint the directory has normalised. Pressing
  // Connect must not write a SECOND entry under the mcpSlug-derived name pointing
  // at the same remote; adopt is the path that promotes it to jobs, not this.
  const d = box();
  chatScope(d, 'stripe', { type: 'http', url: 'https://mcp.stripe.example/mcp' });
  const r = run(d, 'add-custom', b64({ name: 'stripe_mcp', url: 'https://mcp.stripe.example/mcp' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /already connected as "stripe"/i);
  const mcpPath = path.join(d, '.mcp.json');
  const wrote = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers?.stripe_mcp : undefined;
  assert.ok(!wrote, 'no second entry for an endpoint the box already carries');
});

test('user-scope connections are treated the same as local-scope', () => {
  const d = box();
  chatScope(d, 'ustripe', { type: 'http', url: 'https://mcp.stripe.example/mcp' }, 'user');
  assert.equal(svc(run(d, 'status'), 'ustripe').state, 'chat-only');
  assert.equal(run(d, ['adopt', 'ustripe']).ok, true);
});

test('account connectors surface honestly from the cockpit cache, never adoptable (R8)', () => {
  const d = box();
  mkdirSync(path.join(d, 'cockpit'), { recursive: true });
  writeFileSync(path.join(d, 'cockpit', 'connectors.json'), JSON.stringify({ at: Date.now(), names: ['claude.ai Google Drive', 'Asana'] }));
  const r = run(d, 'status');
  const asana = svc(r, 'account-asana');
  assert.ok(asana, 'an account connector renders as a row');
  assert.equal(asana.state, 'account');
  assert.equal(asana.adoptable, false, 'nothing to adopt: the token lives on Anthropic servers');
  assert.match(asana.status, /chats only/i);
  assert.match(asana.status, /never run in scheduled jobs/i);
  // "Google Drive" is one of the Google-family connectors: it annotates the ONE
  // google row instead of spawning a stray account row beside the real offer
  assert.ok(!r.services.some((s) => s.key === 'account-google-drive'), 'a google-family connector never becomes its own row');
  assert.match(svc(r, 'google').status, /chats via your Claude account/i, 'the google row carries the account truth');
});

test('an account connector matching a waiting catalogue row annotates it instead of duplicating (R8)', () => {
  const d = box();
  mkdirSync(path.join(d, 'cockpit'), { recursive: true });
  writeFileSync(path.join(d, 'cockpit', 'connectors.json'), JSON.stringify({ at: Date.now(), names: ['Notion'] }));
  const r = run(d, 'status');
  const notion = svc(r, 'notion');
  assert.equal(notion.state, 'off', 'still the connect-for-jobs offer');
  assert.match(notion.status, /chats via your Claude account/i, 'and it tells the account truth');
  assert.ok(!r.services.some((s) => s.key === 'account-notion'), 'no duplicate row');
});

test('a stale connector cache claims nothing', () => {
  const d = box();
  mkdirSync(path.join(d, 'cockpit'), { recursive: true });
  writeFileSync(path.join(d, 'cockpit', 'connectors.json'), JSON.stringify({ at: Date.now() - 25 * 3600e3, names: ['Asana'] }));
  assert.ok(!run(d, 'status').services.some((s) => s.state === 'account'), 'yesterday’s probe is not today’s truth');
});

test('every row is labelled; raw lowercase keys never reach the page (2026-08-09 audit)', () => {
  // Labels come from engine/lib/connection-labels.mjs, shared with the Overview
  // card's producer, so the two surfaces cannot diverge again.
  const d = box();
  chatScope(d, 'youtube-transcript', { type: 'http', url: 'https://yt.example/mcp' });
  const r = run(d, 'status');
  assert.equal(svc(r, 'notion').label, 'Notion');
  assert.equal(svc(r, 'google').label, 'Google Workspace');
  assert.equal(svc(r, 'youtube-transcript').label, 'Youtube Transcript', 'unknown keys de-kebab + title-case');
  for (const s of r.services) assert.doesNotMatch(String(s.label), /^[a-z]/, `raw key leaked: "${s.label}"`);
});

// ---- BYO Google (2026-08-17, docs/design-google-byo-connect.md) ----

const gseed = (d) => execFileSync('node', [TOKEN_TOOL, d, 'set-google'], { encoding: 'utf8', input: b64({
  email: 'jane@gmail.com', client_id: 'x.apps.googleusercontent.com', client_secret: 'GOCSPX-s',
  access_token: 'GAT', refresh_token: 'GRT', scopes: ['https://www.googleapis.com/auth/gmail.modify'],
}) });

test('add-google writes the workspace-mcp server entry, approved and allowed', () => {
  const d = box();
  const r = run(d, 'add-google', b64({ email: 'Jane@Gmail.com' }));
  assert.equal(r.ok, true);
  assert.equal(r.action, 'add-google');
  const g = JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers.google;
  assert.equal(g.type, 'stdio');
  assert.match(g.command, /workspace-mcp$/);
  assert.ok(g.args.includes('--single-user') && g.args.includes('gmail'));
  assert.equal(g.env.USER_GOOGLE_EMAIL, 'jane@gmail.com', 'email lowercased into the pin');
  assert.equal(g.env.MCP_SINGLE_USER_MODE, '1');
  assert.ok(g.env.WORKSPACE_MCP_CREDENTIALS_DIR.endsWith('.kernel/google-creds'));
  assert.ok(readFileSync(path.join(d, '.kernel', 'mcp-allow'), 'utf8').includes('mcp__google__*'));
  const cj = JSON.parse(readFileSync(path.join(d, '.claude-auth', '.claude.json'), 'utf8'));
  assert.ok(cj.projects[d].enabledMcpjsonServers.includes('google'), 'the click IS the approval');
  assert.equal(run(d, 'add-google', b64({ email: 'nonsense' })).ok, false);
});

test('the google row walks its states: off -> waiting -> on -> dead-marker', () => {
  const d = box();
  assert.equal(svc(run(d, 'status'), 'google').state, 'off');
  run(d, 'add-google', b64({ email: 'jane@gmail.com' }));
  let g = svc(run(d, 'status'), 'google');
  assert.equal(g.state, 'needs-auth');
  assert.match(g.status, /sign in once/i);
  gseed(d);
  g = svc(run(d, 'status'), 'google');
  assert.equal(g.state, 'on');
  assert.match(g.status, /scheduled jobs/i);
  assert.equal(g.renews, true);
  assert.equal(g.rekey_due_at, undefined, 'a published key has no scheduled death, so no countdown rides the row');
  // age the key well past the old 7-day clock: still on — only the probe's
  // dead marker may flip this row (the 2026-08-24 Production reshape)
  const store = JSON.parse(readFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), 'utf8'));
  store.google.keyed_at = Date.now() - 8 * 24 * 3600e3;
  writeFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify(store));
  g = svc(run(d, 'status'), 'google');
  assert.equal(g.state, 'on', 'age alone never expires a key');
  // the probe found invalid_grant and wrote the marker: NOW it is dead
  writeFileSync(path.join(d, '.kernel', 'google-key-dead.json'),
    JSON.stringify({ keyed_at: store.google.keyed_at, dead_at: Date.now() }));
  g = svc(run(d, 'status'), 'google');
  assert.equal(g.state, 'needs-auth');
  assert.match(g.status, /expired/i);
  // a re-key moves keyed_at: the stale marker no longer matches, the row recovers
  gseed(d);
  g = svc(run(d, 'status'), 'google');
  assert.equal(g.state, 'on', 'a stale dead marker from an old key never haunts a fresh one');
});

test('remove google removes the key file itself — the wizard\'s promise', () => {
  const d = box();
  run(d, 'add-google', b64({ email: 'jane@gmail.com' }));
  gseed(d);
  const f = path.join(d, '.kernel', 'google-creds', 'jane@gmail.com.json');
  assert.ok(existsSync(f));
  const r = run(d, ['remove', 'google']);
  assert.equal(r.ok, true);
  assert.ok(!existsSync(f), 'disconnect means the key is gone from the box');
  assert.equal(svc(r, 'google').state, 'off');
});

test('google is fenced: plain add refuses, add-custom cannot shadow it', () => {
  const d = box();
  assert.equal(run(d, ['add', 'google']).ok, false);
  assert.equal(run(d, 'add-custom', b64({ name: 'google', url: 'https://x.example/mcp' })).ok, false);
});

test('a hand-added google server is not overwritten by add-google', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), json({ mcpServers: { google: { type: 'http', url: 'https://their-own.example/mcp' } } }));
  const r = run(d, 'add-google', b64({ email: 'jane@gmail.com' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /hand-added/i);
});
