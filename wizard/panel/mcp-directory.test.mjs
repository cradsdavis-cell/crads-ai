// wizard/panel/mcp-directory.test.mjs: run node --test wizard/panel/mcp-directory.test.mjs
//
// Static contracts for the directory page, mcp-error-state.test.mjs style: read
// the HTML, assert the load-bearing shapes. Driving the rendered page happens
// in the shots rig (Task 6); these greps pin what a refactor must not lose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the page has the three sections in order: yours, browse, by-URL', () => {
  const yours = html.indexOf('id="mcpYours"');
  const browse = html.indexOf('id="mcpBrowse"');
  const custom = html.indexOf('Connect something else');
  assert.ok(yours > -1 && browse > -1 && custom > -1);
  assert.ok(yours < browse && browse < custom, 'yours above browse above the escape hatch');
});

test('your connections renders from the box alone, never gated on the directory', () => {
  const fn = html.match(/function renderMcpYours\([\s\S]*?\n  \}/);
  assert.ok(fn, 'renderMcpYours exists');
  assert.ok(!/mcp-dir\//.test(fn[0]), 'no directory fetch inside the yours renderer');
});

test('browse hides what is already connected', () => {
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/);
  assert.ok(fn, 'renderMcpBrowse exists');
  assert.match(fn[0], /connectedKeys|connectedUrls/, 'browse filters against the connected set');
});

test('the contract gate still guards the whole page', () => {
  assert.match(html, /d\.contract \|\| 0\) < MCP_CONTRACT_NEEDED/, 'the 2026-08-09 skew guard survives the restructure');
});

test('search falls through to the registry, labelled apart from the vouched tier', () => {
  assert.match(html, /From the wider registry/, 'registry hits get their own heading');
  assert.match(html, /mcp-dir\/search\?q=/, 'search hits the route');
  const deb = html.match(/mcpDirSearch[\s\S]{0,400}setTimeout/);
  assert.ok(deb, 'search is debounced, not per-keystroke');
});

// Registry titles, blurbs and urls are written by whoever published the server,
// and they land in both text nodes and HTML attributes. mcpRowHtml has always
// escaped; the directory card did not, so a title of <img src=x onerror=...>
// ran. The card must escape EVERY value it interpolates, both tiers, always.
test('the directory card escapes every value it renders, text and attribute', () => {
  const fn = html.match(/function mcpDirCard\([\s\S]*?\n    \}/);
  assert.ok(fn, 'mcpDirCard exists');
  const body = fn[0];
  // the two text slots
  assert.match(body, /esc\(nm\)/, 'the name is escaped');
  assert.match(body, /esc\(blurb\)/, 'the blurb is escaped');
  // and the attribute values, which is where a bare quote breaks out
  assert.match(body, /'="'\s*\+\s*esc\(/, 'every data-* attribute value goes through esc()');
  // nothing may reach innerHTML raw: any interpolation of a bare identifier
  // (+ nm +, + blurb +, + attrs[k] +) is the defect this test exists to catch
  assert.doesNotMatch(body, /\+\s*(nm|blurb)\s*\+/, 'no unescaped interpolation of nm or blurb');
  assert.doesNotMatch(body, /\+\s*attrs\[k\]\s*\+/, 'no unescaped interpolation of an attribute value');

  // and the callers must hand it values, never a pre-built attribute string,
  // so there is no concatenation site that could skip the escaping above
  const render = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(render, /mcpDirCard\([^)]*'data-/, 'callers pass data as an object, not as raw attribute text');
  assert.match(render, /mcpDirCard\(h\.title, h\.desc, \{/, 'the registry tier goes through the same card');
});

// Design pass 2026-08-23: the shortlist sits straight under the "Add a
// connection" subhead (its count is the heading: "56 services"); only the
// registry tier keeps a named heading, so a search reads as two groups.
test('the shortlist is headed by the Add-a-connection count; the registry tier keeps its own heading', () => {
  const render = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(render, /From our shortlist|From your shortlist/, 'no second heading above the shortlist');
  assert.match(render, /\$\('mcpDirCount'\)\.textContent = offer \? \(offer \+ ' service'/, 'the count is the heading');
  assert.match(render, /data-tier="shortlist"/, 'the shortlist grid is tagged');
  assert.match(render, /From the wider registry/, 'the registry tier is named');
  assert.match(render, /data-tier="registry"/);
});

// Two staleness traps in the same handler: the previous query's registry hits
// surviving the immediate repaint, and an older in-flight fetch landing after a
// newer one and winning because it resolved last.
test('the search handler drops the previous query before repainting, and guards ordering', () => {
  const h = html.match(/\$\('mcpDirSearch'\)\.oninput = function\(\)\{[\s\S]*?\n  \};/);
  assert.ok(h, 'the search handler exists');
  const body = h[0];
  const cleared = body.indexOf('mcpDir.regHits = null');
  const painted = body.indexOf('renderMcpBrowse()');
  const debounced = body.indexOf('setTimeout');
  assert.ok(cleared > -1, 'the previous query\'s hits are dropped');
  assert.ok(cleared < painted, 'dropped BEFORE the immediate repaint, not after');
  assert.ok(cleared < debounced, 'and before the debounce timer is armed');
  assert.match(body, /mcpDir\.regOk = true/, 'and the degrade note resets with them');
  // the ordering guard: a sequence captured per fetch, compared on resolution
  assert.match(body, /var seq = mcpDirSearchSeq/, 'each fetch captures a sequence number');
  assert.match(body, /seq !== mcpDirSearchSeq/, 'and a stale resolution is discarded');
  assert.equal((body.match(/seq !== mcpDirSearchSeq/g) || []).length, 2,
    'both the success and the failure resolution are guarded');
  // an unreadable answer is the same fact as a registry that did not answer
  assert.doesNotMatch(body, /if \(!d \|\| !d\.ok\) return;/, 'a bad shape must degrade, not leave stale state');
  assert.match(body, /if \(!d \|\| !d\.ok\) \{ mcpDir\.regHits = \[\]; mcpDir\.regOk = false/);
});

test('a directory connect stays disabled until the whole flow resolves', () => {
  const fn = html.match(/function mcpDirConnect\([\s\S]*?\n  \}/)[0];
  const probe = fn.indexOf('/mcp-dir/probe');
  const write = fn.indexOf('mcp-add-custom');
  // the re-enable must not sit between the probe answer and the box write
  const between = fn.slice(probe, write);
  assert.doesNotMatch(between, /btn\.disabled = false/, 'the button must not come back alive during the box write');
  assert.match(fn, /function done\(\)\{ if \(btn\) btn\.disabled = false; \}/, 'one named re-enable');
  assert.match(fn, /AbortSignal\.timeout\(6000\)/, 'the probe trip is bounded page-side too');
});

test('the yours filter uses the box\'s own spelling of the chat-only state', () => {
  const fn = html.match(/function renderMcpYours\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /s\.state === 'chat-only'/, 'the box emits chat-only, not chats-only');
  assert.doesNotMatch(fn, /state === 'chats-only'/, 'the mis-spelled state matched nothing');
});

test('connect probes before it offers any button (ruling 2)', () => {
  const fn = html.match(/function mcpDirConnect\([\s\S]*?\n  \}/);
  assert.ok(fn, 'mcpDirConnect exists');
  const body = fn[0];
  assert.match(body, /mcp-dir\/probe/, 'the probe runs');
  assert.match(body, /can_signin/, 'and its verdict is what decides');
  assert.ok(body.indexOf('/mcp-dir/probe') < body.indexOf('mcp-add-custom'), 'probe strictly before any box write');
});

test('a silent server is pointed at the by-URL form, never given a sign-in', () => {
  assert.match(html, /could not tell how it signs in|cannot tell how it signs in/i);
});

test('boxKey entries ride the box featured path, not add-custom', () => {
  const fn = html.match(/function mcpDirConnect\([\s\S]*?\n  \}/);
  assert.match(fn[0], /boxKey/, 'the six featured names keep their box-side identity');
});

// The sign-in-kind filter (spec ruling 4): two pills alongside the category
// chips, filtering the curated tier on entry.auth and hiding the registry
// tier outright while active (registry hits carry no auth field, so there is
// nothing honest to filter them against).
test('the sign-in-kind state slot exists and starts at all', () => {
  assert.match(html, /mcpDir\s*=\s*\{[\s\S]*?\bauth:\s*'all'/, 'mcpDir.auth starts unfiltered');
});

test('renderMcpBrowse renders both sign-in-kind pills alongside the category chips', () => {
  // the pills are built from a small data array, not hand-written HTML, so
  // pin the array's two entries rather than a literal data-auth string
  const pills = html.match(/var MCP_AUTH_PILLS = \[[\s\S]*?\];/);
  assert.ok(pills, 'MCP_AUTH_PILLS exists');
  assert.match(pills[0], /v:\s*'oauth'/, 'an oauth pill');
  assert.match(pills[0], /v:\s*'token'/, 'a token pill');
  assert.match(pills[0], /One click/, 'labelled for a member, not the raw auth value');
  assert.match(pills[0], /Needs a token/);
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /MCP_AUTH_PILLS\.map/, 'renderMcpBrowse builds the pills from that array');
  assert.match(fn, /data-auth="'\s*\+\s*a\.v\s*\+\s*'"/, 'each pill carries its value as a data attribute');
  // same pill styling as the category chips, not a bespoke control
  assert.match(fn, /authChips\s*=\s*MCP_AUTH_PILLS\.map\(function\(a\)\{\s*\n\s*return '<button class="act mcp-chip/, 'the auth pills share the mcp-chip class with the category chips');
});

test('clicking an active sign-in-kind pill toggles the filter back to all', () => {
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /data-auth\]/, 'a dedicated selector for the auth pills, not reusing the category one');
  assert.match(fn, /mcpDir\.auth\s*=\s*\(mcpDir\.auth\s*===\s*v\)\s*\?\s*'all'\s*:\s*v/, 'active pill click returns to all');
});

test('the auth filter combines with category (AND), applied to the curated tier', () => {
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  const filterBody = fn.match(/var visible = mcpDir\.entries\.filter\(function\(e\)\{[\s\S]*?\n\s*\}\);/)[0];
  assert.match(filterBody, /mcpDir\.cat !== 'All'/, 'category still filters');
  assert.match(filterBody, /mcpDir\.auth !== 'all' && e\.auth !== mcpDir\.auth/, 'auth filters too, same clause style');
});

test('registry hits are hidden entirely while the sign-in-kind filter is active', () => {
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /mcpDir\.auth === 'all' && mcpDir\.regHits/, 'the registry block is gated on auth === all');
});

test('a note explains the hidden registry tier, appended to whatever #mcpDirNote already says, only when there is a query', () => {
  const fn = html.match(/function renderMcpBrowse\([\s\S]*?\n  \}/)[0];
  assert.match(fn, /mcpDir\.auth !== 'all' && mcpDir\.q/, 'the note only fires with a live query');
  assert.match(fn, /Registry results are hidden while you filter by sign-in kind/);
  assert.match(fn, /noteText \+= \(noteText \? ' ' : ''\)/, 'appended to, not replacing, an existing note');
});

// The box's NAME_RE is /^[a-z0-9][a-z0-9_-]{1,31}$/: 2 to 32 chars. A
// one-letter registry title ("X") slugged straight through to "x" and the box
// refused it with a name-rule error instead of connecting, because the old
// 'svc-' prefix only fired on a bad FIRST char, never on a too-short result.
test('mcpSlug always yields a name the box will accept (2 to 32 chars)', () => {
  const fn = html.match(/function mcpSlug\([\s\S]*?\n  \}/);
  assert.ok(fn, 'mcpSlug exists');
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
  // eslint-disable-next-line no-new-func
  const mcpSlug = new Function(`${fn[0]}; return mcpSlug;`)();
  for (const input of ['X', 'a', '1', '', '!!!', '-', 'ab', 'a valid Title', 'x'.repeat(50)]) {
    const slug = mcpSlug(input);
    assert.match(slug, NAME_RE, `mcpSlug(${JSON.stringify(input)}) = ${JSON.stringify(slug)} must satisfy the box's NAME_RE`);
  }
});
