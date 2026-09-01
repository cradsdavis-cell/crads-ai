// member-letin-visibility.test.mjs: the "Let this computer in" button must stay
// on screen once the account is known to own the mineral.
//
// QA finding 145 (2026-08-16), driven live on the deployed app while signed in
// and entitled: the button appeared, and then the app's OWN code hid it again at
// 9528ms with no re-fetch in between. A MutationObserver caught the write.
// Pressing the handler directly still completed enrolment in about 90 seconds,
// so nothing about the mechanism was broken. Only the visibility was, and the
// screen it sits on is the one place a member can get their machine admitted.
//
// The cause was a cache flag doing two jobs. showConnError() blanked the button
// on EVERY render and then re-revealed it under `denied && !letIn.dataset.asked`
// - but `asked` latched on the first render, before the async /account/devices
// answered. So render one revealed it (when the fetch landed) and render two
// hid it permanently, because the flag that stopped the re-fetch was also the
// flag that stopped the re-reveal.
//
// not-let-in.test.mjs asserts the source says the right things and qa-not-let-in
// drives one render in a real browser. Neither could see this: the bug only
// exists on the SECOND render. So this file lifts showConnError out of the page
// and calls it repeatedly, the way a 20s connect poll does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

// Lift the real function rather than a copy of its logic: a re-implementation
// here would pass while the page stayed broken, which is exactly the failure
// mode that let this ship.
function liftShowConnError(source) {
  const from = source.indexOf('function showConnError(');
  const to = source.indexOf('function hideConnError(');
  assert.ok(from > -1 && to > from, 'found showConnError in member.html');
  // slugOf is its own helper a few lines above; pass it in rather than dragging
  // the whole neighbourhood along.
  const slugOfFrom = source.indexOf('function slugOf(h){');
  assert.ok(slugOfFrom > -1 && slugOfFrom < from, 'found slugOf above it');
  const body = source.slice(slugOfFrom, to);
  // eslint-disable-next-line no-new-func
  return new Function('$', 'state', 'fetch', body + '; return showConnError;');
}

/** The handful of elements showConnError touches, with the bits it writes. */
function fakePage() {
  const ids = ['connErrHead', 'connErrBody', 'connErrDetail', 'connRetry', 'connError',
    'connLetIn', 'cardGrid', 'dashEmpty'];
  const els = {};
  ids.forEach((id) => { els[id] = { id, textContent: '', innerHTML: '', style: { display: 'none' }, dataset: {} }; });
  return { els, $: (id) => els[id] || null };
}

/** /account/devices, answering with the boxes this account may enrol against. */
function fakeFetch(boxes) {
  const calls = [];
  let resolve;
  const gate = new Promise((r) => { resolve = r; });
  const fn = (path) => {
    calls.push(path);
    return gate.then(() => ({ json: () => Promise.resolve({ ok: true, boxes }) }));
  };
  fn.calls = calls;
  fn.answer = () => { resolve(); return gate.then(() => new Promise((r) => setImmediate(r))); };
  return fn;
}

const ALIAS = 'keith-box';                 // what state.host holds (the local ssh alias)
const REGISTERED = 'keith.crads-ai.com';   // what /account/devices returns
const DENIED = [4, 'Permission denied (publickey).', false, true];   // attempts, detail, isDown, denied

test('finding 145: an entitled account keeps its button across every later render', async () => {
  const show = liftShowConnError(html);
  const page = fakePage();
  const fetch = fakeFetch([{ host: REGISTERED, label: 'Keith' }]);
  const showConnError = show(page.$, { host: ALIAS, data: null }, fetch);

  showConnError(...DENIED);
  assert.equal(page.els.connLetIn.style.display, 'none', 'hidden until the account has answered');
  await fetch.answer();
  assert.equal(page.els.connLetIn.style.display, '', 'shown once the account confirms it owns this mineral');
  assert.equal(page.els.connLetIn.dataset.host, REGISTERED, 'and carries the name the directory issued');

  // The poll keeps failing while the mineral makes up its mind, so showConnError
  // runs again. And again. This is where the live app hid its own way in.
  for (let i = 0; i < 5; i += 1) {
    showConnError(...DENIED);
    assert.equal(page.els.connLetIn.style.display, '', `still on screen at render ${i + 2}`);
  }
  assert.equal(fetch.calls.length, 1, 'and the ask is still cached: one /account/devices, not one per render');
});

test('finding 145: a re-render never re-asks, and never re-hides on the answer it already has', async () => {
  const show = liftShowConnError(html);
  const page = fakePage();
  const fetch = fakeFetch([]);                 // this account owns nothing here
  const showConnError = show(page.$, { host: ALIAS, data: null }, fetch);

  showConnError(...DENIED);
  await fetch.answer();
  assert.equal(page.els.connLetIn.style.display, 'none', 'no button that could not possibly work');
  assert.match(page.els.connErrBody.textContent, /invitation link in your email/i,
    'the one route that can work is named');

  // The same latch hid a second casualty: showConnError rewrites connErrBody from
  // scratch every render, so the honest instruction used to survive exactly one
  // render and was then replaced by the generic "ask it to let this computer in"
  // copy, with no button on screen to do it with.
  showConnError(...DENIED);
  assert.equal(page.els.connLetIn.style.display, 'none', 'still hidden');
  assert.match(page.els.connErrBody.textContent, /invitation link in your email/i,
    'and the instruction is replayed, not overwritten by the copy for people who have a button');
  assert.equal(fetch.calls.length, 1, 'one ask per mineral');
});

test('finding 145: the button belongs to the mineral it was checked for', async () => {
  const show = liftShowConnError(html);
  const page = fakePage();
  const fetch = fakeFetch([{ host: REGISTERED, label: 'Keith' }]);
  const state = { host: ALIAS, data: null };
  const showConnError = show(page.$, state, fetch);

  showConnError(...DENIED);
  await fetch.answer();
  assert.equal(page.els.connLetIn.style.display, '', 'entitled for keith');

  // The target picker switches the whole page to another mineral. An entitlement
  // established for keith says nothing about this one, so it is re-asked.
  state.host = 'janet-box';
  showConnError(...DENIED);
  assert.equal(page.els.connLetIn.style.display, 'none', 'hidden again while the new mineral is checked');
  assert.equal(fetch.calls.length, 2, 'a different mineral earns a second ask');
});

test('finding 145: a state that is no longer refusing us shows no button at all', async () => {
  const show = liftShowConnError(html);
  const page = fakePage();
  const fetch = fakeFetch([{ host: REGISTERED, label: 'Keith' }]);
  const showConnError = show(page.$, { host: ALIAS, data: null }, fetch);

  showConnError(...DENIED);
  await fetch.answer();
  assert.equal(page.els.connLetIn.style.display, '');

  // Not a denial any more: a plain unreachable mineral. Offering "let this
  // computer in" there would be answering a question nobody asked.
  showConnError(6, 'ssh: connect to host 1.2.3.4 port 22: Connection timed out', false, false);
  assert.equal(page.els.connLetIn.style.display, 'none', 'the button follows the denial, not the last render');
});

test('finding 145: a failed ask is not cached as a refusal', async () => {
  const show = liftShowConnError(html);
  const page = fakePage();
  let n = 0;
  const fetch = (path) => {
    n += 1;
    return n === 1 ? Promise.reject(new Error('offline'))
      : Promise.resolve({ json: () => Promise.resolve({ ok: true, boxes: [{ host: REGISTERED }] }) });
  };
  const showConnError = show(page.$, { host: ALIAS, data: null }, fetch);

  showConnError(...DENIED);
  await new Promise((r) => setImmediate(r));
  assert.equal(page.els.connLetIn.style.display, 'none', 'nothing shown on an ask that never answered');

  // A transport failure taught us nothing about entitlement. Caching it as "no"
  // would strand an owner behind one bad moment on the wifi.
  showConnError(...DENIED);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 2, 'the next render asks again');
  assert.equal(page.els.connLetIn.style.display, '', 'and the answer puts the button up');
});
