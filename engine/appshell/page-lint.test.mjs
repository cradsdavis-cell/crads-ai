// page-lint.test.mjs: the page contract, rule by rule (spec 2026-08-25 § 5.1).
//   node --test engine/appshell/page-lint.test.mjs
// NOTE what this is for: every rule here is ALREADY inert at runtime (opaque
// iframe, deny-all CSP, parent-side verb whitelist). The lint exists so an
// author is told their page will not work, at publish, instead of shipping a
// page that silently does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_API_VERBS, lintPage } from './page-lint.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'page-lint.mjs');
const rules = (src) => lintPage(src).violations.map((v) => v.rule);

test('the whitelist is exactly the two read-only brain verbs', () => {
  assert.deepEqual(PAGE_API_VERBS, ['brain-list', 'brain-read']);
});

test('a clean page passes', () => {
  const r = lintPage('<h2>Hi</h2>\n<script>\n  var d = pageApi.data();\n  pageApi.run("brain-list");\n</script>');
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('an external URL is refused, with the line number', () => {
  const r = lintPage('<h2>Hi</h2>\n<img src="https://evil.example/x.png">');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'external-url');
  assert.equal(r.violations[0].line, 2);
});

test('a rule quoted inside an HTML comment is documentation, not code', () => {
  const r = lintPage('<!-- see https://example.com and pageApi.run("box-refresh") -->\n<h2>Hi</h2>');
  assert.equal(r.ok, true, 'comments are stripped before the scan');
});

test('a script src is refused', () => {
  assert.deepEqual(rules('<script src="/x.js"></script>'), ['script-src']);
});

test('network calls are refused, each by name', () => {
  assert.deepEqual(rules('<script>fetch("/x")</script>'), ['network']);
  assert.deepEqual(rules('<script>new XMLHttpRequest()</script>'), ['network']);
  assert.deepEqual(rules('<script>new WebSocket("x")</script>'), ['network']);
  assert.deepEqual(rules('<script>new EventSource("x")</script>'), ['network']);
  assert.deepEqual(rules('<script>import("./x.js")</script>'), ['network']);
});

test('a static import statement is not mistaken for a dynamic one', () => {
  const r = lintPage('<script>\n// the word import in prose, and importantly nothing else\nvar importantThing = 1;\n</script>');
  assert.equal(r.ok, true, 'only import( is dynamic import');
});

test('a non-whitelisted verb is refused and named', () => {
  const r = lintPage('<script>pageApi.run(\'box-refresh\')</script>');
  assert.equal(r.violations[0].rule, 'verb');
  assert.match(r.violations[0].detail, /box-refresh/);
});

test('both quote styles and inner whitespace are handled', () => {
  assert.equal(lintPage('<script>pageApi.run( "brain-read" )</script>').ok, true);
  assert.equal(lintPage("<script>pageApi.run( 'box-refresh' )</script>").ok, false);
});

test('reaching at the containing document is refused', () => {
  assert.deepEqual(rules('<script>parent.postMessage(1)</script>'), ['escape']);
  assert.deepEqual(rules('<script>window.parent.location = "x"</script>'), ['escape']);
  assert.deepEqual(rules('<script>top.document.title = "x"</script>'), ['escape']);
});

test('every violation in a page is reported, not just the first', () => {
  const r = lintPage('<script src="/a.js"></script>\n<script>fetch("/b");parent.x</script>');
  assert.ok(r.violations.length >= 3, `expected 3 or more, got ${r.violations.length}`);
});

test('the engine template pages all pass their own lint', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = join(HERE, 'templates', 'pages');
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.ok(files.length, 'there are template pages to check');
  for (const f of files) {
    const r = lintPage(readFileSync(join(dir, f), 'utf8'));
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r.violations)}`);
  }
});

test('the CLI exits 0 on a clean page and 1 with a named error on a dirty one', () => {
  const d = tmpDir('pagelint-');
  const good = join(d, 'good.html'), bad = join(d, 'bad.html');
  writeFileSync(good, '<h2>Hi</h2>');
  writeFileSync(bad, '<script>fetch("/x")</script>');
  assert.match(execFileSync('node', [CLI, good], { encoding: 'utf8' }), /^OK: /m);
  let out = '', code = 0;
  try { execFileSync('node', [CLI, bad], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
  assert.equal(code, 1);
  assert.match(out, /^ERROR: .*:1: /m);
  rmSync(d, { recursive: true, force: true });
});

// --- Fix-review round (2026-08-25): F1, F2, F3 + the report Minor ---
// F1: the CLI entry guard silently no-oped (exit 0, no output) when invoked
// through a symlink or a copy under a different name, because it matched on
// the basename string 'page-lint.mjs'. Fixed by comparing realpath(argv[1])
// against realpath(this module). F2: the verb rule only matched quote and
// double-quote literals, missing backticks and bracket-notation calls, and
// the network rule missed window["fetch"]-style bracket access. F3: network,
// escape and verb scanned the whole document, so instructional prose or a
// <pre> code sample mentioning a trigger word was refused even though
// nothing there executes; now those three are script-only, and external-url
// (which stays document-wide) exempts <pre>/<code> content.

test('the CLI still works when invoked through a symlink with a different name (F1)', () => {
  const d = tmpDir('pagelint-symlink-');
  const linkPath = join(d, 'lint-runner.mjs');
  symlinkSync(CLI, linkPath);
  const good = join(d, 'good.html'), bad = join(d, 'bad.html');
  writeFileSync(good, '<h2>Hi</h2>');
  writeFileSync(bad, '<script>fetch("/x")</script>');

  assert.match(
    execFileSync('node', [linkPath, good], { encoding: 'utf8' }),
    /^OK: /m,
    'a symlinked invocation must still lint, not silently no-op',
  );

  let out = '', code = 0;
  try { execFileSync('node', [linkPath, bad], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
  assert.equal(code, 1, 'a symlinked invocation must still exit 1 on a dirty file');
  assert.match(out, /^ERROR: .*:1: /m);

  rmSync(d, { recursive: true, force: true });
});

test('a backtick-delimited verb literal is checked, same as quotes (F2)', () => {
  const r = lintPage('<script>pageApi.run(`box-refresh`)</script>');
  assert.equal(r.violations[0].rule, 'verb');
  assert.match(r.violations[0].detail, /box-refresh/);
  assert.equal(lintPage('<script>pageApi.run(`brain-list`)</script>').ok, true);
});

test('bracket-notation pageApi["run"](...) is checked, same as dot notation (F2)', () => {
  const r1 = lintPage('<script>pageApi["run"]("box-refresh")</script>');
  assert.equal(r1.violations[0].rule, 'verb');
  assert.match(r1.violations[0].detail, /box-refresh/);
  const r2 = lintPage("<script>pageApi['run']('brain-list')</script>");
  assert.equal(r2.ok, true, 'a whitelisted verb through bracket notation still passes');
});

test('window["fetch"] bracket-notation network access is refused (F2)', () => {
  const r = lintPage('<script>window["fetch"]("/x")</script>');
  assert.equal(r.violations[0].rule, 'network');
  assert.equal(lintPage("<script>window['XMLHttpRequest']</script>").violations[0].rule, 'network');
});

test('a verb argument that is a variable cannot be checked statically, and is knowingly not caught (F2)', () => {
  const r = lintPage('<script>var v = "box-refresh"; pageApi.run(v);</script>');
  assert.equal(r.ok, true, 'a variable argument is outside what a source-text lint can verify - a documented limit, not a miss');
});

test('prose explaining the contract, and a <pre> code sample quoting it, both pass (F3)', () => {
  const src = [
    '<p>Under the hood this calls fetch(...) and reaches parent. and top. - but only in the sandboxed sense we are describing here, never for real.</p>',
    '<pre>fetch("https://example.com/x"); window.parent.postMessage(1); import("./x.js");</pre>',
  ].join('\n');
  const r = lintPage(src);
  assert.equal(r.ok, true, `expected a clean pass, got ${JSON.stringify(r.violations)}`);
});

test('an <img src> to a remote host outside a <pre> still fails (F3)', () => {
  const r = lintPage('<img src="https://evil.example/x.png">');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'external-url');
});

test('a real fetch inside <script> still fails (F3)', () => {
  const r = lintPage('<script>fetch("/x")</script>');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'network');
});

test('line numbers stay correct after a multi-line <pre> block (F3)', () => {
  const src = [
    '<pre>',
    'line 2 of the code sample',
    'https://example.com',
    'line 4',
    '</pre>',
    '<script>fetch("/x")</script>',
  ].join('\n');
  const r = lintPage(src);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1, `expected only the real fetch, got ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations[0].rule, 'network');
  assert.equal(r.violations[0].line, 6);
});

// --- Fix wave (2026-08-25): I2, M1, M2, M3 ---
// I2: script-scoping (F3) meant inline event handlers were never scanned at
// all, even though the srcdoc CSP is script-src 'unsafe-inline', which
// PERMITS them - so onclick="..." runs on a real box exactly like a <script>
// block. M1: JS // and /* */ comments were not stripped before the code
// rules ran, even though HTML comments already were - contradicting the
// module's own stated principle that a rule named in a comment is
// documentation. M2: the escape rule matched "parent." / "top." anywhere,
// including as a property access on some other object (node.parent.title)
// or inside a string literal ("top.level"). M3: external-url was
// case-sensitive and scheme-strict while the adjacent script-src rule uses
// gi, so HTTPS://... and protocol-relative //host/... both passed.

test('an inline event-handler attribute is scanned like a <script> block (I2)', () => {
  assert.deepEqual(rules(`<button onclick="pageApi.run('box-refresh')">go</button>`), ['verb']);
  assert.deepEqual(rules(`<button onclick="fetch('/x')">go</button>`), ['network']);
  assert.deepEqual(rules(`<button onclick="parent.postMessage(1)">go</button>`), ['escape']);
  assert.equal(lintPage(`<button onclick="pageApi.run('brain-list')">go</button>`).ok, true, 'a whitelisted verb through onclick still passes');
});

test('an inline handler violation keeps the correct line number (I2)', () => {
  const src = ['<h2>Hi</h2>', '<p>line 2</p>', '<button onclick="parent.postMessage(1)">go</button>'].join('\n');
  const r = lintPage(src);
  assert.equal(r.violations[0].rule, 'escape');
  assert.equal(r.violations[0].line, 3);
});

test('a // line comment naming a rule is documentation, not a violation (M1)', () => {
  assert.equal(lintPage('<script>// we cannot fetch( ) here</script>').ok, true);
  assert.equal(lintPage('<script>// pageApi.run("box-refresh") is not allowed</script>').ok, true);
});

test('a /* */ block comment naming a rule is documentation, not a violation (M1)', () => {
  assert.equal(lintPage('<script>/* fetch(x) is not allowed */ var a = 1;</script>').ok, true);
});

test('comment-stripping does not eat a real violation on the same or a later line (M1)', () => {
  const r1 = lintPage('<script>// just a note\nfetch("/x")</script>');
  assert.deepEqual(r1.violations.map((v) => v.rule), ['network']);
  assert.equal(r1.violations[0].line, 2);
  const r2 = lintPage('<script>/* note */ fetch("/x")</script>');
  assert.deepEqual(r2.violations.map((v) => v.rule), ['network']);
});

test('a // inside a URL string literal is not mistaken for a comment opener (M1)', () => {
  const r = lintPage('<script>var u = "https://example.com/x"; fetch(u);</script>');
  assert.deepEqual(r.violations.map((v) => v.rule), ['external-url', 'network']);
});

test('a verb call quoted only inside a comment is not detected as a call (M1)', () => {
  const r = lintPage('<script>// pageApi.run("brain-list") for reference\nvar x = 1;</script>');
  assert.equal(r.ok, true);
});

test('parent./top. as a property access on some other object is not a reach at the document (M2)', () => {
  assert.equal(lintPage('<script>node.parent.title = 1;</script>').ok, true, 'node.parent is a graph field, not window.parent');
  assert.equal(lintPage('<script>r.top.toFixed(2);</script>').ok, true, 'r.top is a rectangle field, not window.top');
  assert.equal(lintPage('<script>var s = "top.level";</script>').ok, true, 'a string literal is not a live reference');
});

test('bare parent./top./window.parent are still refused (M2)', () => {
  assert.deepEqual(rules('<script>parent.postMessage(1)</script>'), ['escape']);
  assert.deepEqual(rules('<script>top.document.title = "x"</script>'), ['escape']);
  assert.deepEqual(rules('<script>window.parent.location = "x"</script>'), ['escape']);
});

test('external-url matches an uppercase scheme (M3)', () => {
  const r = lintPage('<img src="HTTPS://evil.example/x.png">');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'external-url');
});

test('external-url matches a protocol-relative URL (M3)', () => {
  const r = lintPage('<img src="//evil.example/x.png">');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'external-url');
});

test('external-url still matches a plain lowercase https URL (M3)', () => {
  const r = lintPage('<img src="https://evil.example/x.png">');
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, 'external-url');
});
