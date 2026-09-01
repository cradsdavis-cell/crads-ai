#!/usr/bin/env node
// page-lint.mjs: the page contract, in one place (spec 2026-08-25 § 5.1).
//
// What this is for. Every rule below is already inert at runtime: a page
// renders in <iframe sandbox="allow-scripts"> with no allow-same-origin, its
// srcdoc carries default-src 'none', and PAGE_RUN_WHITELIST is checked in the
// parent on every run(). So an unlinted page cannot fetch, cannot reach the
// app, and cannot call an unlisted verb. This lint exists so the author is
// told their page will not work, at publish time, rather than shipping a page
// that renders and silently does nothing.
//
// PAGE_API_VERBS is the single definition of the whitelist. seed-pages.test.mjs
// imports it, panel.test.mjs asserts member.html's runtime PAGE_RUN_WHITELIST
// still matches it, and seed-org-pages.mjs gates on it. Before this module
// those were three literals that happened to agree.
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE_API_VERBS = ['brain-list', 'brain-read'];

// Replace every non-newline character with a space. The point is that the
// result is the same length, with newlines in the same places, as the input
// - so every later line number still lands on the original source line, no
// matter how much of the text this blanks out.
const blank = (s) => s.replace(/[^\n]/g, ' ');

// Every [start, end) span a regex matches in src.
function findSpans(re, src) {
  const spans = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return spans;
}

// Blank OUT the given spans; keep everything else as it was.
function blankSpans(src, spans) {
  let out = src;
  for (const [start, end] of spans) out = out.slice(0, start) + blank(out.slice(start, end)) + out.slice(end);
  return out;
}

// Keep ONLY the given spans; blank everything else.
function keepSpans(src, spans) {
  let out = blank(src);
  for (const [start, end] of spans) out = out.slice(0, start) + src.slice(start, end) + out.slice(end);
  return out;
}

// Comments are stripped first: a rule named in a comment is documentation.
// welcome.html's own header comment names the two whitelisted verbs in prose
// ("run(verb,args) ... accepts read-only brain verbs only ('brain-list',
// 'brain-read')"), so a scanner that read comments would refuse the wording
// it ships with.
const stripComments = (src) => blankSpans(src, findSpans(/<!--[\s\S]*?-->/g, src));

// external-url only: strip <pre> and <code> block content. This product
// ships instructional pages - a code sample showing a URL, or explaining one,
// is not a live reference the CSP will ever be asked to fetch.
const stripPreAndCode = (src) => blankSpans(src, findSpans(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, src));

// network / escape / verb only: keep just CODE - the inner content of
// <script>...</script> tags, and the value of any inline event-handler
// attribute (onclick="...", onload="...", etc). These three rules are about
// what CODE does; a page is mostly prose everywhere else, and prose that
// mentions "fetch(" or "parent." while explaining the sandbox is not running
// anything. An inline handler counts as code too: the srcdoc CSP is
// script-src 'unsafe-inline', which PERMITS inline handlers, so
// onclick="pageApi.run('box-refresh')" runs on a real box exactly like a
// <script> block would, and is the likeliest shape a simple org-authored
// page reaches for.
function codeSpans(src) {
  const spans = [];
  const scriptRe = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
  let m;
  while ((m = scriptRe.exec(src)) !== null) {
    const innerStart = m.index + m[1].length;
    spans.push([innerStart, innerStart + m[2].length]);
  }
  // \b before "on" keeps this from matching mid-word (e.g. "iconname",
  // "salmon-oil"); it only fires on a real on<word>= attribute.
  const onAttrRe = /\bon[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = onAttrRe.exec(src)) !== null) {
    const value = m[1] !== undefined ? m[1] : m[2];
    const valueEnd = m.index + m[0].length - 1; // just before the closing quote
    const valueStart = valueEnd - value.length;
    spans.push([valueStart, valueStart + value.length]);
  }
  return keepSpans(src, spans);
}

// network / escape / verb only, applied AFTER codeSpans: strip // line
// comments and /* */ block comments out of the code so a rule NAMED in a
// comment stays documentation, not a violation - same principle stripComments
// above applies to HTML comments. Walked char by char, tracking string and
// template-literal state, so a "//" inside a URL literal (e.g.
// "https://example.com") is never mistaken for a comment opener, and the
// string content real rules need (e.g. the verb argument) is never eaten.
function stripJsComments(src) {
  const spans = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j += 1;
      spans.push([i, j]);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const j = close === -1 ? n : close + 2;
      spans.push([i, j]);
      i = j;
      continue;
    }
    i += 1;
  }
  return blankSpans(src, spans);
}

const cleanMatch = (m) => m.replace(/\s*\($/, '').trim();

// external-url: document-wide (an <img src> to a remote host is a real dead
// image), minus <pre>/<code> content - see stripPreAndCode above. Matches
// https?:// case-insensitively (HTTPS://evil.example used to pass), plus a
// protocol-relative URL (//evil.example/x.png) right where a real URL
// context opens it - straight after the quote or paren of src="...",
// href='...', or url(...) - which is the shape a live reference takes, not
// the shape an ordinary "// comment" takes.
const EXTERNAL_URL_RULE = {
  rule: 'external-url',
  re: /https?:\/\/|(?<=["'(])\/\/(?=[a-z0-9])/gi,
  detail: () => 'an external URL, which the page CSP blocks',
};

// script-src: document-wide and unchanged. The tag itself, not its content,
// is the violation, so script-scoping does not apply here.
const SCRIPT_SRC_RULE = { rule: 'script-src', re: /<script\b[^>]*\bsrc\s*=/gi, detail: () => 'a script src, which the page CSP blocks' };

// network: code only. window["fetch"](...) / window['fetch'](...) is the
// bracket-notation route to the same calls the bare-word branches catch, and
// is refused the same way.
const NETWORK_RULE = {
  rule: 'network',
  re: /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|import\s*\(|window\s*\[\s*(['"`])(?:fetch|XMLHttpRequest|WebSocket|EventSource)\1\s*\])/g,
  detail: (m) => `${cleanMatch(m)}, which the page CSP blocks`,
};

// escape: code only. (?<![.'"`]) excludes a match preceded by a dot (a
// property access on some OTHER object - node.parent.title, r.top.toFixed(2)
// - not the global) or by a quote/backtick (text inside a string or template
// literal - "top.level" - not a live reference). Bare parent., top., and
// window.parent (nothing to their left, or plain whitespace/punctuation) are
// unaffected.
const ESCAPE_RULE = {
  rule: 'escape',
  re: /(?<![.'"`])\b(?:window\s*\.\s*parent|parent\s*\.|top\s*\.)/g,
  detail: () => 'a reach at the containing document, which the sandbox blocks',
};

function scanRule(text, { rule, re, detail }, lineOf, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ rule, detail: detail(m[0]), line: lineOf(m.index) });
    if (m[0].length === 0) re.lastIndex += 1;
  }
}

// verb: code only. pageApi.run('verb' | "verb" | `verb`), or the equivalent
// bracket call pageApi['run'](...) / pageApi["run"](...) / pageApi[`run`](...).
//
// A call whose verb argument, or whose method key, is a variable rather than
// a literal - pageApi.run(v), pageApi[k]('run') - cannot be told apart from a
// whitelisted call by reading source text. That is the honest limit of a
// static scan, not an oversight: a lint that pretended to resolve runtime
// values would be lying about what it checked. Left alone, on purpose - see
// the page-lint.test.mjs case "a verb argument that is a variable cannot be
// checked statically".
function* verbCalls(codeSrc) {
  const dotRe = /pageApi\s*\.\s*run\s*\(\s*(['"`])([^'"`]*)\1/g;
  let m;
  while ((m = dotRe.exec(codeSrc)) !== null) yield { value: m[2], index: m.index };

  const bracketRe = /pageApi\s*\[\s*(['"`])run\1\s*\]\s*\(\s*(['"`])([^'"`]*)\2/g;
  while ((m = bracketRe.exec(codeSrc)) !== null) yield { value: m[3], index: m.index };
}

export function lintPage(source) {
  const raw = String(source == null ? '' : source);
  const noComments = stripComments(raw);
  const lineOf = (index) => noComments.slice(0, index).split('\n').length;

  const codeOnly = stripJsComments(codeSpans(noComments));
  const proseSafe = stripPreAndCode(noComments);

  const violations = [];
  scanRule(proseSafe, EXTERNAL_URL_RULE, lineOf, violations);
  scanRule(noComments, SCRIPT_SRC_RULE, lineOf, violations);
  scanRule(codeOnly, NETWORK_RULE, lineOf, violations);
  scanRule(codeOnly, ESCAPE_RULE, lineOf, violations);

  for (const { value, index } of verbCalls(codeOnly)) {
    if (PAGE_API_VERBS.includes(value)) continue;
    violations.push({ rule: 'verb', detail: `pageApi.run("${value}") is not one of ${PAGE_API_VERBS.join(', ')}`, line: lineOf(index) });
  }

  violations.sort((a, b) => a.line - b.line);
  return { ok: violations.length === 0, violations };
}

// CLI entry guard. Compares the REAL path of the invoked file against the
// real path of this module, not a basename string match: a bare
// `endsWith('page-lint.mjs')` check silently no-ops (exits 0, prints
// nothing) the moment this file is invoked through a symlink or a copy under
// a different name, because neither ever passes that check. Same latent bug
// class as brain-template's main-guard. realpathSync resolves symlinks on
// both sides before comparing, so a differently-named symlink still resolves
// to this file and the CLI still runs.
function isDirectlyInvoked() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI: page-lint <file.html>
if (isDirectlyInvoked()) {
  const [, , file] = process.argv;
  if (!file) { console.log('usage: page-lint <file.html>'); process.exit(2); }
  const name = basename(file);
  let src = '';
  try { src = readFileSync(file, 'utf8'); }
  catch { console.log(`ERROR: ${name}: could not be read`); process.exit(1); }
  const { ok, violations } = lintPage(src);
  if (ok) { console.log(`OK: ${name}`); process.exit(0); }
  for (const x of violations) console.log(`ERROR: ${name}:${x.line}: ${x.detail}`);
  process.exit(1);
}
