// commons-lib.test.mjs: the join bundle round-trip, its refusal cases, git
// URL validation and the shared git environment (self-host pivot, 2026-09-01).
//   node --test engine/community/commons-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  BUNDLE_PREFIX, ORG_RE, gitEnvFor, listCommunities, mintBundle, parseBundle,
  readCommonsConf, readCommunity, removeCommunity, tokenArgsFor, validGitUrl,
  writeCommunity,
} from './commons-lib.mjs';

// ---- bundle round trip -----------------------------------------------------

test('bundle: mint then parse round-trips every field', () => {
  const b = mintBundle({ org: 'harbour-guild', org_display: 'Harbour Guild', url: 'https://github.com/hg/hg-commons.git', branch: 'main' });
  assert.ok(b.startsWith(BUNDLE_PREFIX));
  const p = parseBundle(b);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.community.org, 'harbour-guild');
  assert.equal(p.community.org_display, 'Harbour Guild');
  assert.equal(p.community.url, 'https://github.com/hg/hg-commons.git');
  assert.equal(p.community.branch, 'main');
  assert.equal(p.community.urlKind, 'https');
  assert.equal(p.community.urlHost, 'github.com');
});

test('bundle: branch is optional and display defaults to the org', () => {
  const p = parseBundle(mintBundle({ org: 'hg', url: 'git@github.com:hg/hg-commons.git' }));
  assert.equal(p.ok, true, p.error);
  assert.equal(p.community.org_display, 'hg');
  assert.equal(p.community.branch, undefined);
  assert.equal(p.community.urlKind, 'ssh');
});

test('bundle: whitespace around a pasted bundle is tolerated', () => {
  const b = mintBundle({ org: 'hg', url: 'https://github.com/hg/c' });
  assert.equal(parseBundle('  ' + b + '\n').ok, true);
});

test('bundle: malformed input is refused loudly, never guessed at', () => {
  const cases = [
    ['', /empty/],
    ['crads1:abc', /does not look like a community bundle/],
    [BUNDLE_PREFIX, /not base64|damaged/],
    [BUNDLE_PREFIX + '!!!not-base64!!!', /not base64/],
    [BUNDLE_PREFIX + Buffer.from('not json').toString('base64'), /does not decode/],
    [BUNDLE_PREFIX + Buffer.from('[1,2]').toString('base64'), /does not decode/],
    [BUNDLE_PREFIX + Buffer.from(JSON.stringify({ org: 'Bad Org', url: 'https://github.com/a/b' })).toString('base64'), /community name/],
    [BUNDLE_PREFIX + Buffer.from(JSON.stringify({ org: 'ok-org', url: 'file:///etc/passwd' })).toString('base64'), /repository address/],
    [BUNDLE_PREFIX + Buffer.from(JSON.stringify({ org: 'ok-org', url: 'https://github.com/a/b', branch: '-evil' })).toString('base64'), /branch/],
    [BUNDLE_PREFIX + 'x'.repeat(5000), /too long/],
    [42, /one line of text/],
  ];
  for (const [input, re] of cases) {
    const p = parseBundle(input);
    assert.equal(p.ok, false, `should refuse: ${String(input).slice(0, 60)}`);
    assert.match(p.error, re, `error names the problem for: ${String(input).slice(0, 60)}`);
  }
});

test('bundle: a file URL never parses, even with the test override set', () => {
  const prev = process.env.AIOS_COMMONS_ALLOW_FILE;
  process.env.AIOS_COMMONS_ALLOW_FILE = '1';
  try {
    const b = BUNDLE_PREFIX + Buffer.from(JSON.stringify({ org: 'ok-org', url: '/tmp/somewhere' })).toString('base64');
    assert.equal(parseBundle(b).ok, false, 'bundles are strict regardless of the puller override');
  } finally {
    if (prev === undefined) delete process.env.AIOS_COMMONS_ALLOW_FILE;
    else process.env.AIOS_COMMONS_ALLOW_FILE = prev;
  }
});

test('mint refuses what parse would refuse', () => {
  assert.throws(() => mintBundle({ org: 'Bad Org', url: 'https://github.com/a/b' }), /org/);
  assert.throws(() => mintBundle({ org: 'ok', url: 'ext::sh -c whoami' }), /url/);
  assert.throws(() => mintBundle({ org: 'ok', url: 'https://github.com/a/b', branch: '-x' }), /branch/);
});

// ---- URL validation --------------------------------------------------------

test('validGitUrl: accepts the four commons shapes and names the transport', () => {
  assert.equal(validGitUrl('https://github.com/a/b.git').kind, 'https');
  assert.equal(validGitUrl('https://git.example.co:8443/a/b').kind, 'https');
  assert.equal(validGitUrl('ssh://git@github.com/a/b.git').kind, 'ssh');
  assert.equal(validGitUrl('git@github.com:a/b.git').kind, 'ssh');
  assert.equal(validGitUrl('git://example.com/a/b').kind, 'git');
});

test('validGitUrl: refuses everything else', () => {
  const bad = [
    'file:///etc/passwd', '/etc/passwd', 'ext::sh -c whoami', 'http://github.com/a/b',
    '-https://github.com/a/b', 'https://github.com/a/../b', 'git@github.com:../up',
    'https://github.com/a b', 'https://github.com/a\tb', 'https://github.com/a\nb',
    '', 'not a url', 'https://', 'ssh://host', 'x'.repeat(400),
  ];
  for (const u of bad) assert.equal(validGitUrl(u).ok, false, `should refuse: ${u.slice(0, 40)}`);
});

test('validGitUrl: local paths only under the explicit test override', () => {
  assert.equal(validGitUrl('/tmp/repo.git').ok, false);
  assert.equal(validGitUrl('/tmp/repo.git', { allowFile: true }).kind, 'file');
  assert.equal(validGitUrl('file:///tmp/repo.git', { allowFile: true }).kind, 'file');
  assert.equal(validGitUrl('/tmp/../etc', { allowFile: true }).ok, false, 'dot-dot refused even for files');
});

// ---- git environment -------------------------------------------------------

test('gitEnvFor pins the transport allow-list and never prompts', () => {
  const env = gitEnvFor({ url: 'https://github.com/a/b' }, { env: {} });
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https:ssh:git');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_SSH_COMMAND, undefined, 'no ssh command for an https commons');
  const sshEnv = gitEnvFor({ url: 'git@github.com:a/b.git' }, { keyPath: '/state/secrets/commons_key.hg', env: {} });
  assert.match(sshEnv.GIT_SSH_COMMAND, /-i \/state\/secrets\/commons_key\.hg/);
  assert.match(sshEnv.GIT_SSH_COMMAND, /BatchMode=yes/);
});

test('gitEnvFor widens to file transport only under the env override', () => {
  const env = gitEnvFor({ url: '/tmp/x' }, { env: { AIOS_COMMONS_ALLOW_FILE: '1' } });
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https:ssh:git:file');
});

test('tokenArgsFor: the GitHub token goes to github.com and nowhere else', () => {
  assert.equal(tokenArgsFor('https://github.com/a/b', 'tok').length, 2);
  assert.match(tokenArgsFor('https://github.com/a/b', 'tok')[1], /^http\.https:\/\/github\.com\/\.extraheader=Authorization: Basic /);
  assert.deepEqual(tokenArgsFor('https://gitlab.com/a/b', 'tok'), [], 'a hostile bundle host never receives the token');
  assert.deepEqual(tokenArgsFor('git@github.com:a/b.git', 'tok'), [], 'https only');
  assert.deepEqual(tokenArgsFor('https://github.com/a/b', ''), [], 'no token, no header');
});

// ---- community records -----------------------------------------------------

test('community records: write, read, list, remove', () => {
  const state = tmpDir('commons-lib-');
  writeCommunity(state, { org: 'aaa-guild', org_display: 'AAA', url: 'https://github.com/a/a', status: 'joined' });
  writeCommunity(state, { org: 'bbb-guild', org_display: 'BBB', url: 'https://github.com/b/b', status: 'joined' });
  assert.equal(readCommunity(state, 'aaa-guild').org_display, 'AAA');
  assert.equal(readCommunity(state, 'zzz'), null);
  assert.deepEqual(listCommunities(state).map((c) => c.org), ['aaa-guild', 'bbb-guild']);
  removeCommunity(state, 'aaa-guild');
  assert.deepEqual(listCommunities(state).map((c) => c.org), ['bbb-guild']);
  assert.throws(() => writeCommunity(state, { org: '../up' }), /org/);
});

test('listCommunities skips damaged records and foreign files', () => {
  const state = tmpDir('commons-lib-');
  mkdirSync(path.join(state, 'communities.d'), { recursive: true });
  writeFileSync(path.join(state, 'communities.d', 'broken.json'), 'not json');
  writeFileSync(path.join(state, 'communities.d', 'notes.txt'), 'hi');
  writeFileSync(path.join(state, 'communities.d', 'Bad Name.json'), '{}');
  writeCommunity(state, { org: 'ok-guild', url: 'https://github.com/a/a' });
  assert.deepEqual(listCommunities(state).map((c) => c.org), ['ok-guild']);
});

test('readCommonsConf reads what commons-admin writes and nothing else', () => {
  const state = tmpDir('commons-lib-');
  assert.equal(readCommonsConf(state), null);
  writeFileSync(path.join(state, 'commons.conf'), 'URL=https://github.com/a/c.git\nBRANCH=main\nORG=hg\nORG_DISPLAY=Harbour Guild\n');
  const c = readCommonsConf(state);
  assert.equal(c.url, 'https://github.com/a/c.git');
  assert.equal(c.branch, 'main');
  assert.equal(c.org, 'hg');
  assert.equal(c.org_display, 'Harbour Guild');
});

test('ORG_RE matches the narrowest inbox consumers', () => {
  for (const ok of ['hg', 'harbour-guild', 'a1', 'x'.repeat(38)]) assert.ok(ORG_RE.test(ok), ok);
  for (const bad of ['x', '-lead', 'trail-', 'Big', 'a b', 'x'.repeat(39), 'dots.no']) assert.ok(!ORG_RE.test(bad), bad);
});
