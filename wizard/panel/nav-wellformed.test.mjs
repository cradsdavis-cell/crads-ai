// nav-wellformed.test.mjs: every nav group closes, so no tab is nested in a
// group it does not belong to.
//
// Until 2026-09-18 the "assistant" and "privacy" .navgroup divs were never
// closed. The browser nested Privacy inside Your assistant and the Terminal
// tab inside Privacy, so hiding the Privacy group (the local face does) hid
// the Terminal tab with it, and the shots rig's nav helper reported Terminal
// as a Privacy tab. Parsed here with a real DOM so the check is structural.
//   node --test wizard/panel/nav-wellformed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('each .navgroup div in #nav closes before the next group or tab starts', () => {
  const nav = html.slice(html.indexOf('<nav id="nav">'), html.indexOf('</nav>') + 6).replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  // walk the div tags with a depth counter; each navgroup must return to the
  // depth it opened at before the next navgroup or top-level tab
  const re = /<div\b[^>]*>|<\/div>|<button data-sec="([a-z]+)"/g;
  let depth = 0; const opens = []; let m;
  const topLevel = [];
  while ((m = re.exec(nav))) {
    if (m[0].startsWith('<div')) { depth++; if (/class="navgroup"/.test(m[0])) opens.push(depth); }
    else if (m[0] === '</div>') depth--;
    else if (depth === 0) topLevel.push(m[1]);
    if (m[0].startsWith('<div') && /class="navgroup"/.test(m[0])) assert.equal(depth, 1, `a navgroup opened nested at depth ${depth}: the previous group never closed`);
  }
  assert.equal(depth, 0, 'every div in #nav is closed');
  assert.ok(topLevel.includes('terminal'), `Terminal is a top-level tab (top level: ${topLevel.join(', ')})`);
});
