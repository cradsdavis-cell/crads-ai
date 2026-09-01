// p2-prompts-verb.test.mjs: the box-side Prompts read (spec 2026-08-25 § 5.2).
//   node --test wizard/panel/p2-prompts-verb.test.mjs
// Shell verb runs for real against a fixture tree, like p2-ties-verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');

function box({ withEngine = true } = {}) {
  const root = tmpDir('p2prompts-');
  mkdirSync(path.join(root, 'state'), { recursive: true });
  if (withEngine) {
    const dst = path.join(root, 'app', 'engine', 'appshell');
    mkdirSync(dst, { recursive: true });
    cpSync(path.join(HERE, '..', '..', 'engine', 'appshell', 'prompts-list.mjs'), path.join(dst, 'prompts-list.mjs'));
  }
  const w = (rel, body) => {
    const p = path.join(root, 'state', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const run = (cmd) => {
    let out = '', code = 0;
    try { out = execFileSync('bash', ['-c', rewrite(root, cmd)], { encoding: 'utf8', cwd: root }); }
    catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { root, w, run, done: () => rmSync(root, { recursive: true, force: true }) };
}

const state = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('PROMPTS_STATE '));
  assert.ok(line, `a PROMPTS_STATE line is always emitted, got: ${out}`);
  return JSON.parse(line.slice('PROMPTS_STATE '.length));
};

test('prompt-list is a read-only member verb', () => {
  const v = MEMBER_VERBS['prompt-list'];
  assert.ok(v, 'prompt-list is registered in MEMBER_VERBS');
  assert.notEqual(v.mutating, true, 'reading prompts never mutates');
  assert.notEqual(v.adminOnly, true, 'a member reads their own prompts');
});

test('prompt-list returns what the engine found', () => {
  const b = box();
  b.w('org-inbox/prompts/onboarding-pack/kickoff.md', '---\ntitle: Kick off a client\n---\nAsk me about the client.\n');
  const r = b.run(MEMBER_VERBS['prompt-list'].build({}).command);
  assert.equal(r.code, 0);
  const s = state(r.out);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].title, 'Kick off a client');
  b.done();
});

test('an image too old to carry the script reports dormant, never a hard error', () => {
  const b = box({ withEngine: false });
  const r = b.run(MEMBER_VERBS['prompt-list'].build({}).command);
  assert.equal(r.code, 0, 'the verb still exits clean');
  const s = state(r.out);
  assert.deepEqual(s.prompts, []);
  assert.match(s.dormant || '', /update/i, 'the member is told the box needs an update, not shown an error');
  b.done();
});

const MEMBER_HTML = readFileSync(path.join(HERE, 'member.html'), 'utf8');

test('the Prompts tab renders on the Skills page and copies the body only', () => {
  assert.match(MEMBER_HTML, /loadPrompts/, 'a loader exists');
  assert.match(MEMBER_HTML, /PROMPTS_STATE/, 'the marker prefix is parsed in the client');
  // the copy target is the prompt body, never the title or the card markup
  assert.match(MEMBER_HTML, /navigator\.clipboard\.writeText\(/, 'copy uses the clipboard API');
  // dormant and empty are distinct states: "nothing offered" must not read as "broken"
  assert.match(MEMBER_HTML, /promptsEmpty/, 'an explicit empty state exists');
});

test('member-facing prompt copy carries no em dashes', () => {
  // Scans the actual visible copy this task added, not id tokens: the heading
  // line (which also carries the info-tip tooltip), the promptsEmpty
  // empty-state line, and every string literal inside loadPrompts (which is
  // where the dormant / error / copy-failure notices live). A regex keyed off
  // "prompt" + a quote only ever matches attribute/variable names like
  // id="promptsNotice" and would pass with an em dash sitting in the visible
  // tooltip text right next to it, so this asserts over spans that actually
  // contain the prose.
  const headingLine = MEMBER_HTML.split('\n').find((l) => l.includes('Prompts<button'));
  assert.ok(headingLine, 'the Prompts heading/tooltip line exists');
  assert.ok(!headingLine.includes('\u2014'), 'em dash in the Prompts heading or its tooltip');

  const emptyLine = MEMBER_HTML.split('\n').find((l) => l.includes('id="promptsEmpty"'));
  assert.ok(emptyLine, 'the promptsEmpty empty-state line exists');
  assert.ok(!emptyLine.includes('\u2014'), 'em dash in the promptsEmpty copy');

  const fnStart = MEMBER_HTML.indexOf('function loadPrompts(');
  assert.ok(fnStart >= 0, 'loadPrompts is defined');
  const braceStart = MEMBER_HTML.indexOf('{', fnStart);
  let depth = 0, fnEnd = braceStart;
  for (; fnEnd < MEMBER_HTML.length; fnEnd++) {
    if (MEMBER_HTML[fnEnd] === '{') depth++;
    else if (MEMBER_HTML[fnEnd] === '}') { depth--; if (depth === 0) { fnEnd++; break; } }
  }
  const loader = MEMBER_HTML.slice(fnStart, fnEnd);
  const literals = [...loader.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]);
  assert.ok(literals.length > 0, 'loadPrompts has string literals to scan (dormant/error/copy notices)');
  for (const lit of literals) assert.ok(!lit.includes('\u2014'), `em dash in a loadPrompts string literal: ${lit}`);
});
