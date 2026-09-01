// p2-authoring-ui.test.mjs: the pack content editor on the Catalogue page
// (Phase 5, task 3, 2026-08-25) — editing a prompt or page inside a pack
// that already exists, wired to Task 2's three verbs.
//   node --test wizard/panel/p2-authoring-ui.test.mjs
//
// Static checks against member.html's markup and script text, same idiom as
// p2-sections.test.mjs: slice the file around the section/function under
// test rather than executing it (this app has no DOM test harness) — except
// for the one driven test at the bottom, which follows secrets-iter2.test.mjs's
// own precedent of spawning the real dev harness against a local Playwright
// install when one is available, and skipping cleanly when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(HERE, 'member.html'), 'utf8');

const publishStart = HTML.indexOf('<section data-sec="publish"');
const publishEnd = HTML.indexOf('</section>', publishStart);
const PUBLISH = HTML.slice(publishStart, publishEnd);

function fnBody(name, approxLen) {
  const at = HTML.indexOf('function ' + name + '(');
  assert.ok(at >= 0, `function ${name} exists`);
  return HTML.slice(at, at + approxLen);
}

test('the editor markup lives inside the publish section, no new nav entry', () => {
  assert.ok(publishStart >= 0, 'the publish section exists');
  assert.match(PUBLISH, /<h3 class="subhead zonegap">Pack content/, 'a group heading, like Files and Prompts');
  assert.match(PUBLISH, /id="packAuthPack"/);
  assert.match(PUBLISH, /id="packAuthFiles"/);
  assert.match(PUBLISH, /id="packAuthName"/);
  assert.match(PUBLISH, /id="packAuthText"/);
  assert.match(PUBLISH, /id="packAuthSave"/);
  assert.match(PUBLISH, /id="packAuthNotice"/);
  assert.match(PUBLISH, /id="packAuthEmpty"/);
  assert.match(PUBLISH, /id="packAuthBody"/);
});

test('no new nav button was added for this editor', () => {
  // The brief was explicit that this task adds no new nav entry; the editor
  // rides the Catalogue page. ORG_SECS (the org nav list this used to check)
  // died with the face collapse (2026-09-01), so the pin is now direct: no
  // packauth-shaped tab in the one nav, and no section of its own.
  assert.ok(!HTML.includes('ORG_SECS'), 'the org nav list itself is gone');
  assert.ok(!/data-sec="packauth/.test(HTML), 'no new data-sec section for pack authoring');
  assert.ok(!/<button[^>]*data-sec="[^"]*packauth/i.test(HTML), 'no packauth-shaped nav button');
});

test('a loader function exists and parses PACKS_STATE, distinguishing dormant, error and empty', () => {
  const fn = fnBody('loadPackAuthoring', 2400);
  assert.match(fn, /pack-content-list/);
  assert.match(fn, /PACKS_STATE/);
  assert.match(fn, /dormant/);
  assert.match(fn, /\.error/, 'a read failure is not rendered as an empty pack list');
});

test('the loader is wired into activateSec beside loadCatalogue, on the publish section', () => {
  const at = HTML.indexOf("if (name === 'publish')");
  assert.ok(at >= 0);
  // two separate "if (name === 'publish')" lines, not merged into one: an
  // existing test (community-pipe.test.mjs) pins the exact original text of
  // the loadCatalogue line, so loadPackAuthoring rides a second condition
  // rather than folding into it.
  const zone = HTML.slice(at, at + 400);
  assert.match(zone, /if \(name === 'publish'\) loadCatalogue\(\);/);
  assert.match(zone, /if \(name === 'publish'\) loadPackAuthoring\(\);/);
});

test('save paths call prompt-write and page-write with content_b64, through b64utf8', () => {
  const fn = fnBody('packAuthSave', 6200);
  assert.match(fn, /run\(kind === 'prompt' \? 'prompt-write' : 'page-write'/, 'the two write verbs are the only save targets');
  assert.match(fn, /content_b64:\s*b64utf8\(content\)/, 'content is base64-encoded via the existing helper, never sent raw');
  // the pack, and either name (prompt) or id (page), travel as args — not
  // interpolated into any string the way the community-blurb bug did
  assert.match(fn, /args\.name = name/);
  assert.match(fn, /args\.id = name/);
  assert.match(fn, /pack:\s*pack\.id/);
});

test('the not-shipped indication names the pack-manifest consequence', () => {
  const fn = fnBody('renderPackAuthFiles', 4200);
  assert.match(fn, /row\.shipped/);
  assert.match(fn, /will not reach members until it is listed in the pack manifest/);
});

test('the empty state says a pack is made in Claude Code', () => {
  assert.match(PUBLISH, /id="packAuthEmpty"[^>]*>[\s\S]*?Claude Code/);
});

test('the editor states plainly that it never loads existing content: create/replace only', () => {
  // both the static copy and the "target this name" click handler restate it,
  // so an operator cannot land on the form believing a click loaded a file
  const fn = fnBody('renderPackAuthFiles', 4200);
  assert.match(PUBLISH, /does not load a file's current text/);
  assert.match(fn, /the box below is still empty/i);
});

test('overwrite is a deliberate act: an existing name is confirmed before saving', () => {
  const fn = fnBody('packAuthSave', 6200);
  assert.match(fn, /packAuthFileExists\(pack, kind, name\)/);
  assert.match(fn, /confirm\(/, 'the browser confirm() gate, same idiom as deleteMemberPage');
  assert.match(fn, /overwrite:\s*exists/);
});

test('save reports the verb\'s own output on both success and refusal', () => {
  const fn = fnBody('packAuthSave', 6200);
  assert.match(fn, /outText\(r\)/, 'the verb\'s own lines (including a page-lint ERROR: line) are shown, not a paraphrase');
});

test('every field rendered from brain content uses textContent, never innerHTML of a raw value', () => {
  const fns = ['renderPackAuthPicker', 'packAuthPackChanged', 'renderPackAuthFiles', 'packAuthSave', 'loadPackAuthoring'];
  for (const name of fns) {
    const fn = fnBody(name, 6200);
    const bad = fn.match(/\.innerHTML\s*=\s*[^;]+;/g) || [];
    for (const m of bad) {
      assert.ok(/^\.innerHTML\s*=\s*'';$/.test(m.trim()) || /^\.innerHTML\s*=\s*""\s*;$/.test(m.trim()),
        `${name} sets innerHTML to something other than a clear: ${m}`);
    }
  }
});

test('no em dashes in the added copy', () => {
  // the same scan p2-sections.test.mjs runs for the Files section: the
  // markup zone plus every string literal in each new function.
  assert.ok(!PUBLISH.slice(PUBLISH.indexOf('Pack content')).includes('—'), 'no em dash in the pack-authoring markup');
  const fns = ['loadPackAuthoring', 'renderPackAuthPicker', 'packAuthPackChanged', 'renderPackAuthFiles', 'packAuthFileExists', 'packAuthPriorShipped', 'packAuthSave'];
  for (const name of fns) {
    const fn = fnBody(name, 6200);
    const literals = fn.match(/'[^']*'/g) || [];
    for (const s of literals) assert.ok(!s.includes('—'), `em dash in a ${name} string literal: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// Review findings, 2026-08-26
// ---------------------------------------------------------------------------

test('F1(a): a shipped file whose name fails the write-verb shape is never offered for targeting', () => {
  // Root cause named in the review: pack-content.mjs applies NO shape rule to
  // prompt filenames and a WIDER one to page ids than prompt-write/page-write's
  // own kebab-only regex, so a file can ship (shipped:true) under a name this
  // panel can never save. One shared regex, defined once, used by both the
  // render pass and the save pass, so they can never disagree with each other
  // the way the original bug let them.
  const nameReCount = (HTML.match(/PACK_AUTH_NAME_RE\s*=\s*\/\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$\//g) || []).length;
  assert.equal(nameReCount, 1, 'the shape regex is declared exactly once, not re-inlined per function');

  const render = fnBody('renderPackAuthFiles', 4200);
  assert.match(render, /if \(!editable\) btn\.disabled = true/, 'a non-editable row disables Target this name');
  assert.match(render, /if \(!editable\) return;/, 'the click handler itself refuses to act even if somehow fired');
  assert.match(render, /does not fit the letters, numbers and hyphens this panel needs to save/, 'the real reason is stated, not the generic save-time shape error');
  assert.match(render, /rename or edit it in Claude Code/i, 'names the actual remedy');

  const save = fnBody('packAuthSave', 6200);
  assert.match(save, /PACK_AUTH_NAME_RE\.test\(name\)/, 'the save-time validation of the TYPED name reuses the shared regex, not a second copy that could drift');
});

// ---------------------------------------------------------------------------
// Final review, 2026-08-26: F1(a)'s own fix over-generalised (final review
// F1) and F1(a) as first shipped could itself destroy a file (final review
// F2). Both corrected below.
// ---------------------------------------------------------------------------

test('final review F1: a non-editable row never claims it ships when it does not', () => {
  const render = fnBody('renderPackAuthFiles', 4200);
  // The false universal claim from the first fix round is gone: "it still
  // ships fine to members as it is" is no longer unconditional text, it is
  // one branch of a ternary keyed on row.shipped.
  assert.match(render, /row\.shipped\s*\n\s*\?\s*'This file.s name does not fit[\s\S]*?still ships fine to members as it is/, 'the "still ships" wording is gated on row.shipped, not stated unconditionally');
  assert.match(render, /does not ship to members as it is either/, 'the non-shipping non-editable case gets its own, honest wording');
});

test('final review F1: a manifest-listed, undeliverable file gets a distinct notice naming the real fix', () => {
  const render = fnBody('renderPackAuthFiles', 4200);
  assert.match(render, /row\.manifestOnly/, 'the manifestOnly flag from pack-content.mjs is read');
  assert.match(render, /Listed in the pack manifest, but this name will not reach members/, 'distinct from the plain not-shipped line: renaming the file is the fix, not touching the manifest');
  // manifestOnly and plain not-shipped are mutually exclusive branches, not
  // two independent ifs that could both print
  assert.match(render, /if \(row\.manifestOnly\) \{[\s\S]*?\} else if \(!row\.shipped\) \{/);
});

test('final review F2: editability is decided from the row\'s full on-disk label, never a derived stem', () => {
  // The old derivation stripped ".md" if present and left the name alone
  // otherwise, so an extension-less prompts/kickoff produced the SAME stem
  // as prompts/kickoff.md, "kickoff" -- both passed the old shape check, so
  // Target enabled on both, and saving the extension-less row (prompt-write
  // always appends ".md") silently overwrote the real kickoff.md. Matching
  // the FULL label removes the ambiguity: an extension-less name can never
  // match a pattern that requires a trailing ".md".
  const promptReCount = (HTML.match(/PROMPT_LABEL_RE\s*=\s*\/\^prompts\\\/\[a-z0-9\]\[a-z0-9-\]\{0,62\}\\\.md\$\//g) || []).length;
  assert.equal(promptReCount, 1, 'the prompt label shape is declared exactly once');
  const pageReCount = (HTML.match(/PAGE_LABEL_RE\s*=\s*\/\^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\\\.html\$\//g) || []).length;
  assert.equal(pageReCount, 1, 'the page label shape is declared exactly once');

  const render = fnBody('renderPackAuthFiles', 4200);
  assert.match(render, /var editable = \(row\.kind === 'prompt' \? PROMPT_LABEL_RE : PAGE_LABEL_RE\)\.test\(row\.label\)/, 'editability reads the LABEL (extension included), never the derived target/stem');
  assert.doesNotMatch(render, /PACK_AUTH_NAME_RE\.test\(row\.target\)/, 'the old lossy-stem check is gone from the render pass');

  // an extension-less name genuinely fails the new label check directly
  assert.equal(/^prompts\/[a-z0-9][a-z0-9-]{0,62}\.md$/.test('prompts/kickoff'), false);
  assert.equal(/^prompts\/[a-z0-9][a-z0-9-]{0,62}\.md$/.test('prompts/kickoff.md'), true);
});

test('F1(b): saving a name different from the one targeted requires a distinct confirm naming both files', () => {
  const save = fnBody('packAuthSave', 6200);
  assert.match(save, /var t = PACKAUTH\.targeted/);
  assert.match(save, /var diverged = !!t && \(t\.pack !== pack\.id \|\| t\.kind !== kind \|\| t\.name !== name\)/, 'divergence is pack+kind+name aware, not name-only');
  // the diverged branch must be checked BEFORE the plain overwrite branch, so
  // a silent no-confirm orphan-file save (the exact bug the review named) is
  // structurally impossible: an if/else-if, not two independent ifs that
  // could both be skipped.
  assert.match(save, /if \(diverged\) \{[\s\S]*?\} else if \(exists\) \{/);
  assert.match(save, /Saving now creates a new ' \+ kind \+ ' called "' \+ name \+ '"\. It will not touch "' \+ t\.name \+ '"/, 'the new-file case names the file that will NOT be touched');
  assert.match(save, /Saving now replaces the existing ' \+ kind \+ ' "' \+ name \+ '"\. It will not touch "' \+ t\.name \+ '"/, 'the different-existing-file case names both files distinctly');
  assert.match(save, /confirm\(divMsg\)/, 'the divergence confirm gates the save, same as the plain overwrite confirm');
  // targeting state is set only from an editable row, and cleared after a
  // successful save (nothing stays targeted once the file it named is written)
  assert.match(fnBody('renderPackAuthFiles', 4200), /PACKAUTH\.targeted = \{ pack: pack\.id, kind: row\.kind, name: row\.target \};/);
  assert.match(save, /PACKAUTH\.targeted = null;/);
});

test('final review F4: a successful save of a new or previously-unshipped file states the manifest consequence right in the success notice', () => {
  // Before this fix the only statement of the out-of-scope boundary was a
  // per-row warning the operator had to go back and read after the reload;
  // the notice printed straight after Save was just the verb's own OK line,
  // which reads as published. This computes the flag from the listing
  // already on screen, BEFORE the write, and appends one sentence to the
  // notice text used on both the refreshedOk and the refresh-failed paths.
  const save = fnBody('packAuthSave', 6200);
  assert.match(save, /var needsManifestNotice = !exists \|\| !packAuthPriorShipped\(pack, kind, name\);/, 'computed before the write, from the listing already on screen');
  assert.match(save, /if \(r\.ok && needsManifestNotice\) \{/, 'only appended on a successful save, and only when it applies');
  assert.match(save, /msg \+= ' This file will not reach members until it is added to the pack manifest, pack\.yaml, which is edited in Claude Code, not here\.';/);
  // it is appended to msg BEFORE the r.ok branch runs, so both the
  // refreshedOk and the refresh-failed notice paths (which both read msg)
  // carry it, not just one of them
  const appendAt = save.indexOf('msg += \' This file will not reach members');
  const okBranchAt = save.indexOf('if (r.ok) {');
  assert.ok(appendAt >= 0 && okBranchAt >= 0 && appendAt < okBranchAt, 'the sentence is folded into msg before the success branch reads it');
});

test('final review F4: packAuthPriorShipped reads the same row shape packAuthFileExists already searches, prior shipped state only', () => {
  const fn = fnBody('packAuthPriorShipped', 500);
  assert.match(fn, /kind === 'prompt' \? f\.name === 'prompts\/' \+ name \+ '\.md' : f\.id === name/, 'the same lookup predicate as packAuthFileExists, not a second copy that could drift');
  assert.match(fn, /return !!\(row && row\.shipped\);/);
});

test('F2: a network/stream failure on the write itself re-enables Save and reports it, same idiom as catPublishRow', () => {
  const save = fnBody('packAuthSave', 6200);
  const writeCall = save.slice(save.indexOf("run(kind === 'prompt' ? 'prompt-write' : 'page-write', args)"));
  assert.match(writeCall, /\.then\(function\(r\)\{[\s\S]*?\}\)\.catch\(function\(e\)\{/, 'the write call itself is guarded by a .catch, not just the .then');
  const catchBlock = writeCall.slice(writeCall.indexOf('.catch(function(e){'));
  assert.match(catchBlock, /if \(btn\) btn\.disabled = false;/, 'Save is re-enabled on a rejected write, not left stuck disabled until reload');
  assert.match(catchBlock, /The save did not complete: /);
});

test('F3: a failed post-save refresh keeps its own notice; the save result is appended, not overwritten', () => {
  const save = fnBody('packAuthSave', 6200);
  assert.match(save, /loadPackAuthoring\(\)\.then\(function\(refreshedOk\)\{/, 'the save path inspects whether the reload actually succeeded');
  assert.match(save, /if \(refreshedOk\) \{ notice\('packAuthNotice', msg\); return; \}/);
  assert.match(save, /var cur = \(\$\('packAuthNotice'\) \|\| \{\}\)\.textContent \|\| '';/, 'the existing (failure) notice text is read back, not assumed empty');
  assert.match(save, /notice\('packAuthNotice', \(cur \? cur \+ '\\n\\n' : ''\) \+ msg\);/, 'appended after the existing text, never replacing it outright');

  const load = fnBody('loadPackAuthoring', 2400);
  // Un-gated since the face collapse (2026-09-01): every mineral can author
  // pack content, so the non-org early return is gone and the loader must
  // not grow a face check back.
  assert.ok(!load.includes('IS_ORG'), 'no face gate in the loader');
  assert.match(load, /if \(!r\.ok\) \{ notice\('packAuthNotice', 'Could not read your packs:\\n' \+ outText\(r\)\); return false; \}/);
  assert.match(load, /if \(s\.dormant\) \{ notice\('packAuthNotice', s\.dormant\); empty\.style\.display = 'none'; body\.style\.display = 'none'; return false; \}/);
  assert.match(load, /if \(s\.error\) \{ notice\('packAuthNotice', 'Could not read your packs just now\. Try again in a moment\.'\); return false; \}/);
  assert.match(load, /return true;/, 'the happy path (including the empty-packs branch) resolves true');
});

test('F4: switching packs drops stale targeting state and its notice, not just the file list', () => {
  const fn = fnBody('packAuthPackChanged', 900);
  assert.match(fn, /PACKAUTH\.targeted = null;/);
  assert.match(fn, /notice\('packAuthNotice', ''\);/);
  assert.match(fn, /renderPackAuthFiles\(\);/, 'still repaints the file list for the newly selected pack');
  // and it is actually the pack select's change handler, not a dead function
  assert.match(HTML, /\$\('packAuthPack'\)\.onchange = packAuthPackChanged;/);
});

// ---------------------------------------------------------------------------
// Driven: the non-kebab trap, in a real browser against the real dev harness.
// Same optional-local-Playwright pattern as secrets-iter2.test.mjs's driven
// test: skip cleanly when wizard/dev-harness has no local playwright install
// (the shared MCP browser is contended all session and cannot be relied on).
// ---------------------------------------------------------------------------
let chromium = null;
try { ({ chromium } = await import(path.join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: the non-kebab row cannot be targeted, and a diverged save is confirmed distinctly', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
  const PORT = 4000 + Math.floor(Math.random() * 2000);
  const harness = spawn(process.execPath, [path.join(HERE, '..', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
    harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
    harness.on('exit', (c) => rej(new Error('harness exited early ' + c)));
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/panel`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    // The one-face nav (2026-09-01): the "Open Catalogue" dashboard CTA died
    // with the org face; the Catalogue tab lives in a collapsed nav group, so
    // open its group with a real click first (same pattern as dev-harness nav.mjs).
    const { navTo } = await import(path.join(HERE, '..', 'dev-harness', 'nav.mjs'));
    await navTo(page, 'publish', 600);
    await page.waitForFunction(() => {
      const sel = document.getElementById('packAuthPack');
      return sel && sel.options.length > 0;
    }, { timeout: 8000 });

    // Playwright's string `hasText` is a case-insensitive substring match,
    // which would make "Kickoff.md" and "kickoff.md" collide (strict-mode
    // violation, confirmed while writing this test). Find each row by EXACT,
    // case-sensitive title text in-page instead, then address it by index.
    const cardIndex = async (exactTitle) => page.evaluate((title) => {
      const cards = [...document.querySelectorAll('#packAuthFiles .guidecard')];
      return cards.findIndex((c) => c.querySelector('.gtitle')?.textContent === title);
    }, exactTitle);

    // the non-kebab prompt row (prompts/Kickoff.md, shipped:true): Target is
    // disabled and the real reason is on screen, not the generic save-time error
    const kickoffIdx = await cardIndex('Prompt: prompts/Kickoff.md');
    assert.ok(kickoffIdx >= 0, 'the non-kebab prompt row rendered');
    const kickoffCard = page.locator('#packAuthFiles .guidecard').nth(kickoffIdx);
    assert.equal(await kickoffCard.locator('button').isDisabled(), true, 'Target this name is disabled on the non-kebab row');
    const kickoffText = await kickoffCard.innerText();
    assert.match(kickoffText, /does not fit the letters, numbers and hyphens/);
    assert.doesNotMatch(kickoffText, /lowercase letters, numbers and hyphens, starting with/, 'the generic save-time message never appears here: this is the real reason, stated up front');
    // Kickoff.md genuinely ships (case-insensitive delivery), so the "still
    // ships fine" claim is TRUE here and must stay on screen (final review F1).
    assert.match(kickoffText, /still ships fine to members as it is/);

    // final review F2: the extension-less sibling (prompts/kickoff, no
    // ".md") is the destructive collision case. Its label can never match
    // the write verb's full shape, so Target is disabled here too -- and
    // unlike Kickoff.md, it genuinely does NOT ship, so the honest,
    // non-shipping wording must be on screen, never the "still ships" claim.
    const extlessIdx = await cardIndex('Prompt: prompts/kickoff');
    assert.ok(extlessIdx >= 0, 'the extension-less prompt row rendered');
    const extlessCard = page.locator('#packAuthFiles .guidecard').nth(extlessIdx);
    assert.equal(await extlessCard.locator('button').isDisabled(), true, 'Target this name is disabled on the extension-less row: it can never collide with kickoff.md again');
    const extlessText = await extlessCard.innerText();
    assert.match(extlessText, /does not fit the letters, numbers and hyphens/);
    assert.match(extlessText, /does not ship to members as it is either/, 'honest: this file does not ship, unlike Kickoff.md');
    assert.doesNotMatch(extlessText, /still ships fine to members as it is/, 'the false "still ships" claim never appears on a genuinely non-shipping row');

    // final review F1: a manifest-listed prompt with the wrong extension
    // (prompts/notes.txt) gets the distinct manifestOnly notice, not the
    // plain not-shipped line, since the fix here is renaming the file, not
    // touching an already-correct manifest entry.
    const wrongExtIdx = await cardIndex('Prompt: prompts/notes.txt');
    assert.ok(wrongExtIdx >= 0, 'the wrong-extension prompt row rendered');
    const wrongExtCard = page.locator('#packAuthFiles .guidecard').nth(wrongExtIdx);
    assert.equal(await wrongExtCard.locator('button').isDisabled(), true, 'Target this name is disabled: ".txt" can never match the write verb\'s ".md"-only shape');
    const wrongExtText = await wrongExtCard.innerText();
    assert.match(wrongExtText, /Listed in the pack manifest, but this name will not reach members/);
    assert.doesNotMatch(wrongExtText, /^Not shipped\. This file will not reach members until it is listed in the pack manifest\./m, 'the plain not-shipped line is not shown alongside the more specific manifestOnly one');

    // the non-kebab page row (v2.notes, shipped:true): same treatment
    const notesIdx = await cardIndex('Page: v2.notes.html');
    assert.ok(notesIdx >= 0, 'the non-kebab page row rendered');
    const notesCard = page.locator('#packAuthFiles .guidecard').nth(notesIdx);
    assert.equal(await notesCard.locator('button').isDisabled(), true, 'Target this name is disabled on the non-kebab page row');

    // target the clean kickoff prompt, then hand-edit the name before saving:
    // F1(b) must catch this even though nothing about the ROW was non-kebab
    const cleanIdx = await cardIndex('Prompt: prompts/kickoff.md');
    assert.ok(cleanIdx >= 0, 'the clean kebab prompt row rendered');
    const clean = page.locator('#packAuthFiles .guidecard').nth(cleanIdx);
    await clean.locator('button').click();
    await page.waitForTimeout(150);
    await page.fill('#packAuthName', 'a-different-name');
    await page.fill('#packAuthText', 'Fresh content for a different file entirely.');

    let dialogMsg = null;
    page.once('dialog', async (d) => { dialogMsg = d.message(); await d.accept(); });
    await page.click('#packAuthSave');
    await page.waitForTimeout(1200);
    assert.ok(dialogMsg, 'a confirm dialog fired for the diverged save');
    assert.match(dialogMsg, /You targeted the prompt "kickoff"/);
    assert.match(dialogMsg, /save as "a-different-name" instead/);
    assert.match(dialogMsg, /creates a new prompt called "a-different-name"/);
    assert.match(dialogMsg, /will not touch "kickoff"/);
    const notice = await page.locator('#packAuthNotice').innerText();
    assert.match(notice, /OK: prompt a-different-name saved to onboarding-pack\./, 'the confirmed save still goes through and reports the verb\'s own line');

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    harness.kill();
  }
});
