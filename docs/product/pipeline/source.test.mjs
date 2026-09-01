// Pins the docs source contract (spec 2026-08-24-documentation-system.md):
// the two axes, the disarmed access gate, the how-to-ships-an-artefact
// ruling, the legal version stamp, and cumulative tier visibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, validatePage, loadTree, visibleTo } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'test-fixtures');

const fm = (over = {}) => ({
  title: 'A page', summary: 'One line.', audience: 'public', access: 'public', mode: 'explanation', ...over,
});

test('a valid page validates and fills defaults', () => {
  const p = validatePage(fm());
  assert.equal(p.order, 999);
  assert.equal(p.generated, false);
  assert.equal(p.installs, null);
});

test('the enums refuse what the spec refuses', () => {
  assert.throws(() => validatePage(fm({ audience: 'member' })), /audience must be/);
  assert.throws(() => validatePage(fm({ mode: 'guide' })), /mode must be/);
  // access is the DISARMED gate: public is the only value until it arms
  assert.throws(() => validatePage(fm({ access: 'pebble' })), /gate is disarmed/);
});

test('a PEBBLE how-to without installs: refuses; public and rock ones do not', () => {
  // Pebble craft IS the recipe library, so a pebble how-to ships its pattern.
  assert.throws(() => validatePage(fm({ mode: 'how-to', audience: 'pebble' })), /requires installs/);
  const ok = validatePage(fm({ mode: 'how-to', audience: 'pebble', installs: 'inbox-triage' }));
  assert.equal(ok.installs, 'inbox-triage');
  // Public machinery how-tos install nothing: the product already has the button.
  assert.equal(validatePage(fm({ mode: 'how-to', audience: 'public' })).installs, null);
  // Rock hosting craft is human practice. There is no installable artefact that
  // makes someone good at running a room, and demanding one would mean naming a
  // recipe that does not exist.
  assert.equal(validatePage(fm({ mode: 'how-to', audience: 'rock' })).installs, null);
});

test('a legal page without version + effective date refuses', () => {
  assert.throws(() => validatePage(fm({ mode: 'legal' })), /version/);
  assert.throws(() => validatePage(fm({ mode: 'legal', version: '1.0', effective: 'soon' })), /YYYY-MM-DD/);
  const ok = validatePage(fm({ mode: 'legal', version: '1.0', effective: '2026-08-24' }));
  assert.equal(ok.effective, '2026-08-24');
});

test('frontmatter parsing is strict, not lenient (the wiki lesson)', () => {
  assert.throws(() => parseFrontmatter('no fences here'), /no frontmatter/);
  assert.throws(() => parseFrontmatter('---\nTitle = wrong\n---\nbody'), /bad frontmatter line/);
  const { fm: parsed, body } = parseFrontmatter('---\ntitle: Hi\n---\nBody.');
  assert.equal(parsed.title, 'Hi');
  assert.equal(body, 'Body.');
});

test('loadTree loads the fixtures and refuses duplicate slugs', () => {
  const pages = loadTree(FIX);
  assert.ok(pages.length >= 3);
  assert.ok(pages.every((p) => p.slug && p.body.length));
});

test('visibility is cumulative: pebble sees public, rock sees both', () => {
  const pages = loadTree(FIX);
  const pub = visibleTo(pages, 'public').map((p) => p.audience);
  assert.ok(pub.every((a) => a === 'public'));
  const rock = new Set(visibleTo(pages, 'rock').map((p) => p.audience));
  assert.ok(rock.has('public') && rock.has('pebble') && rock.has('rock'));
  assert.throws(() => visibleTo(pages, 'operator'), /unknown tier/);
});
