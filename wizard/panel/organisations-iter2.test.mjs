// organisations-iter2.test.mjs — panel iteration 2 (2026-08-23), R23 + R4 on
// the Organisations page: no "Ask to anchor" once the picked mineral is
// anchored; the anchored row (only) offers "Change to join", which calls
// POST /rock-tie-downgrade {org, host}; org-owned rows keep the ownership
// line; the "Behind the door" browse is gone.
// Run: node --test wizard/panel/organisations-iter2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const fn = (a, b) => html.slice(html.indexOf('function ' + a + '('), html.indexOf('function ' + b + '('));

// A DOM small enough to hold a drawer: createElement + appendChild + textContent.
function el(tag) {
  const e = { tag, children: [], attrs: {}, className: '', _html: '', style: {}, disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelector() { return null; } };
  Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
  Object.defineProperty(e, 'textContent', { get() { return this._text || ''; }, set(v) { this._text = v; } });
  return e;
}
function buttons(node, out = []) {
  if (node.tag === 'button') out.push(node);
  node.children.forEach((c) => buttons(c, out));
  return out;
}
function text(node) {
  return (node._html || '') + (node._text || '') + node.children.map(text).join('');
}

// The page's functions, lifted with the globals they read wired to a fixture.
function page(opts) {
  const src = fn('rockPickedSlug', 'rockBrainOf')
    + fn('rockHasAnchor', 'rockInstall')   // rockHasAnchor + rockJoinBlock
    + fn('rockTieBlock', 'rockBrainBlock')
    + fn('rockDowngrade', 'loadRocks');
  const calls = [];
  const g = {
    IS_ORG: !!opts.org,
    state: { host: opts.host || 'priya-box', targets: [{ host: opts.host || 'priya-box', org: opts.slug || 'priya' }] },
    rockMineSt: { signedIn: true, mine: JSON.parse(JSON.stringify(opts.mine || [])) },   // copies: the page writes to its cache
    rockLocalAnchor: opts.local || null,
    document: { createElement: el },
    esc: (s) => String(s),
    notice: (id, t) => calls.push(['notice', id, t]),
    confirm: () => (opts.confirm !== false),
    fetch: (url, init) => { calls.push(['fetch', url, JSON.parse(init.body)]);
      return Promise.resolve({ status: opts.status || 200, json: () => Promise.resolve(opts.reply || { ok: true }) }); },
    loadRocks: () => calls.push(['loadRocks']),
    rockAsk: () => calls.push(['rockAsk']), rockAskAnchor: () => calls.push(['rockAskAnchor']), rockLeave: () => calls.push(['rockLeave']),
    rockOwnLine: () => 'tie line',
  };
  const names = Object.keys(g);
  const f = new Function(...names, src + '; return { rockHasAnchor, rockJoinBlock, rockTieBlock, rockDowngrade, g: { get rockMineSt(){ return rockMineSt; }, get rockLocalAnchor(){ return rockLocalAnchor; } } };');
  return { ...f(...names.map((k) => g[k])), calls };
}

const anchoredTie = { org: 'impact-colab', tie: 'anchored', owner: 'member', slug: 'priya', minerals: ['priya'] };
const joinedTie = { org: 'harbour-guild', tie: 'joined', owner: 'member', slug: 'priya', minerals: ['priya'] };

test('R23: "Ask to anchor" is offered only while the picked mineral has no anchor', () => {
  const free = page({ mine: [joinedTie] });
  assert.equal(free.rockHasAnchor(), false);
  assert.deepEqual(buttons(free.rockJoinBlock('northwind', {})).map((b) => b.textContent), ['Join', 'Ask to anchor']);

  const anchored = page({ mine: [anchoredTie, joinedTie] });
  assert.equal(anchored.rockHasAnchor(), true, 'a directory anchored row for this mineral');
  assert.deepEqual(buttons(anchored.rockJoinBlock('northwind', {})).map((b) => b.textContent), ['Join'], 'no anchor ask');
  assert.match(text(anchored.rockJoinBlock('northwind', {})), /Your anchor stays where it is/);

  const local = page({ mine: [], local: { org: 'impact-colab', name: 'Acme CoLab', owner: 'member' } });
  assert.equal(local.rockHasAnchor(), true, 'the anchor the mineral itself records counts');

  const owned = page({ mine: [{ org: 'impact-colab', tie: 'anchored', owner: 'org', slug: 'priya', minerals: ['priya'] }] });
  assert.equal(owned.rockHasAnchor(), true, 'owned is anchored');

  const other = page({ mine: [{ ...anchoredTie, slug: 'jeff', minerals: ['jeff'] }] });
  assert.equal(other.rockHasAnchor(), false, 'another of the account\'s minerals being anchored does not anchor this one');

  const rock = page({ org: true, mine: [] });
  assert.equal(rock.rockHasAnchor(), true, 'a rock can never be anchored to a rock');
  assert.deepEqual(buttons(rock.rockJoinBlock('northwind', {})).map((b) => b.textContent), ['Join']);
});

test('R4: the untied drawer no longer browses the rock: no Behind the door, no counts', () => {
  const p = page({ mine: [] });
  const blk = p.rockJoinBlock('northwind', { skills: 12, pages: 4 });
  assert.doesNotMatch(text(blk), /Behind the door|12 skills|4 shared pages/);
});

test('R23: "Change to join" sits on the anchored row only, and calls the route for the picked mineral', async () => {
  const p = page({ mine: [anchoredTie, joinedTie] });
  const a = buttons(p.rockTieBlock('impact-colab', anchoredTie)).map((b) => b.textContent);
  assert.deepEqual(a, ['Leave your anchor', 'Change to join']);
  const j = buttons(p.rockTieBlock('harbour-guild', joinedTie)).map((b) => b.textContent);
  assert.deepEqual(j, ['Leave'], 'a joined row has nothing to downgrade');
  const dg = buttons(p.rockTieBlock('impact-colab', anchoredTie)).find((b) => b.textContent === 'Change to join');
  assert.equal(dg.attrs['data-downgrade'], 'impact-colab');
  dg.onclick();
  await new Promise((r) => setTimeout(r, 10));
  const f = p.calls.find((c) => c[0] === 'fetch');
  assert.ok(f, 'the route is called');
  assert.equal(f[1], '/rock-tie-downgrade');
  assert.deepEqual(f[2], { org: 'impact-colab', host: 'priya-box' }, 'org + the picked mineral\'s host');
  assert.ok(p.calls.some((c) => c[0] === 'loadRocks'), 'rocks reload on success');
  const n = p.calls.find((c) => c[0] === 'notice');
  assert.match(n[2], /hosted and billed by Crads AI, the Mountain/);
  assert.equal(p.g.rockLocalAnchor, null, 'the mineral\'s own anchor record is re-read, not trusted');
  assert.equal(p.g.rockMineSt.mine[0].tie, 'joined', 'the cache says joined');
});

test('the confirm says what moves and what does not, and a refusal is shown verbatim', async () => {
  const src = fn('rockDowngrade', 'loadRocks');
  assert.match(src, /Change your tie to ' \+ org \+ ' from anchored to joined\?\\n\\nYou stay a member and keep everything installed\. Your mineral goes back to being hosted and billed by Crads AI, the Mountain\. Nothing else moves\./);
  const declined = page({ mine: [anchoredTie], confirm: false });
  buttons(declined.rockTieBlock('impact-colab', anchoredTie)).find((b) => b.textContent === 'Change to join').onclick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(declined.calls.filter((c) => c[0] === 'fetch').length, 0, 'no call without a yes');
  const refused = page({ mine: [anchoredTie], status: 409, reply: { error: 'this mineral is owned by the rock; ownership moves first' } });
  const b = buttons(refused.rockTieBlock('impact-colab', anchoredTie)).find((x) => x.textContent === 'Change to join');
  b.onclick();
  await new Promise((r) => setTimeout(r, 10));
  const n = refused.calls.find((c) => c[0] === 'notice');
  assert.equal(n[2], 'this mineral is owned by the rock; ownership moves first', 'the 4xx body, verbatim');
  assert.equal(b.disabled, false, 'and the button comes back');
  assert.ok(!refused.calls.some((c) => c[0] === 'loadRocks'), 'nothing reloads on a refusal');
});

test('an org-owned mineral shows the ownership line instead of any tie action', () => {
  const p = page({ mine: [] });
  const blk = p.rockTieBlock('impact-colab', { org: 'impact-colab', tie: 'anchored', owner: 'org', minerals: ['priya'] });
  assert.deepEqual(buttons(blk), [], 'no Leave, no Change to join');
  assert.match(text(blk), /Ownership moves from Your pebble, never from here\./);
});

test('"Change to join" is drawn only when the row stands for the picked mineral', () => {
  const p = page({ mine: [anchoredTie], host: 'jeff-box', slug: 'jeff' });
  const a = buttons(p.rockTieBlock('impact-colab', anchoredTie)).map((b) => b.textContent);
  assert.deepEqual(a, ['Leave your anchor'], 'priya\'s anchored row, with jeff picked: the route would act on jeff');
  const many = { ...anchoredTie, minerals: ['priya', 'jeff'] };
  const b = buttons(p.rockTieBlock('impact-colab', many)).map((x) => x.textContent);
  assert.ok(b.includes('Change to join'), 'a row that includes the picked mineral offers it once');
  assert.equal(b.filter((x) => x === 'Change to join').length, 1);
});

test('the page head has a bubble, and no em dashes on the Organisations page', () => {
  const sec = html.slice(html.indexOf('<section data-sec="rocks">'), html.indexOf('<section data-sec="rockreader">')).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(sec, /<h2>Organisations<button class="info" type="button"[^>]*data-tip="[^"]{80,}"/);
  assert.doesNotMatch(sec, /—/);
  assert.doesNotMatch(sec, /behind its door/);
  const js = html.slice(html.indexOf('function rockOwnLine('), html.indexOf('function loadRocks('));
  assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /—/);
  assert.doesNotMatch(js, /community floor/, 'the retired model is gone from the tie lines too');
});

// Sam, 2026-08-23: "the Organisations tab should never include itself (the
// rock) as an option to join". rockSelfIds gathers every handle the page
// knows for this mineral; the board filter drops rows matching any of them.
test('a rock never lists itself on the open-rocks board, whatever name the board uses', () => {
  const src = html.slice(html.indexOf('function rockSelfIds('), html.indexOf('function rockPickedSlug('));
  const g = {
    IS_ORG: true,
    state: { host: 'flat-earth-society-of-am-rock', targets: [{ host: 'flat-earth-society-of-am-rock', org: 'Flat Earth Society of America' }] },
    orgx: { gov: { 'org.name': 'flat-earth-society-of-am', 'org.display_name': 'Flat Earth Society of America' } },
    $: () => ({ textContent: 'flat-earth-society-of-am' }),
  };
  const names = Object.keys(g);
  const rockSelfIds = new Function(...names, src + '; return rockSelfIds;')(...names.map((k) => g[k]));
  const ids = rockSelfIds('Flat Earth Society of America');
  for (const k of ['flat-earth-society-of-am', 'flat earth society of america']) assert.ok(ids[k], 'knows itself as ' + k);
  // the filter the board applies (kept in step with rockRenderBoard)
  const board = [
    { org: 'flat-earth-society-of-am', org_display: 'Flat Earth Society of America' },
    { org: 'FLAT-EARTH-SOCIETY-OF-AM', org_display: '' },
    { org: 'harbour-guild', org_display: 'Harbour Guild' },
  ];
  const rows = board.filter((c) => !ids[String(c.org || '').toLowerCase()] && !ids[String(c.org_display || '').toLowerCase()]);
  assert.deepEqual(rows.map((c) => c.org), ['harbour-guild']);
  assert.match(html.slice(html.indexOf('function rockRenderBoard('), html.indexOf('function rockRenderBoard(') + 4000), /rockSelfIds\(sel\)/, 'the board uses it');
});
