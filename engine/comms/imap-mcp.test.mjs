// imap-mcp.test.mjs: run node --test engine/comms/imap-mcp.test.mjs
//
// The on-box email connection over IMAP (2026-11-05). The server is driven
// over real stdio, the way Claude Code runs it, against a fake IMAP server
// (tests/fake-imap.mjs) that records every command. What is pinned: it sends
// nothing (no SMTP, no tool that sends); folders are opened read-only and
// messages read with PEEK, so nothing is ever marked, moved or deleted; a
// draft goes to the folder the server marks \Drafts, flagged \Draft, threaded
// under the email it answers; a password that is not plain ASCII travels as a
// literal; a wrong password and an unreachable server read as words the
// member can act on; plain IMAP never leaves this machine; one connection at
// a time. The parsing pieces are pinned on their own below.
//
// The same server was also driven by hand against a real Dovecot 2.3 over
// plain, TLS and STARTTLS on 2026-11-05 (see the commit message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startFakeImap } from '../../tests/fake-imap.mjs';
import {
  TOOLS, Reader, parseParts, utf7Encode, utf7Decode, decodeWords, walkMessage, htmlToText,
  buildDraft, addressList, imapDate, headerParams, openConnection,
} from './imap-mcp.mjs';

const SCRIPT = path.join(import.meta.dirname, 'imap-mcp.mjs');
const PASS = 'app-pässword';   // not plain ASCII on purpose: it must go as a literal

// ---- the pieces --------------------------------------------------------------

test('responses are split on lines, with literals kept whole as bytes', () => {
  const got = [];
  const r = new Reader((p) => got.push(p));
  r.push(Buffer.from('* 1 FETCH (UID 7 BODY[]<0> {5}\r\nhel'));
  r.push(Buffer.from('lo)\r\n* OK [UIDNEXT 9] ok\r\n'));
  assert.equal(got.length, 2);
  assert.ok(Buffer.isBuffer(got[0][1]));
  assert.equal(got[0][1].toString(), 'hello');
  assert.equal(got[0][2], ')');
  const v = parseParts(got[0]);
  assert.deepEqual(v.slice(0, 3), ['*', '1', 'FETCH']);
  assert.equal(v[3][2], 'BODY[]<0>', 'an atom keeps its brackets');
  assert.equal(v[3][3].toString(), 'hello');
});

test('lists nest, quoted strings unescape, NIL is null, a bracketed section with spaces stays one atom', () => {
  const v = parseParts(['* LIST (\\HasNoChildren \\Drafts) "/" "My \\"Box\\"" NIL BODY[HEADER.FIELDS (REFERENCES)]']);
  assert.deepEqual(v[2], ['\\HasNoChildren', '\\Drafts']);
  assert.equal(v[4], 'My "Box"');
  assert.equal(v[5], null);
  assert.equal(v[6], 'BODY[HEADER.FIELDS (REFERENCES)]');
});

test('folder names round-trip through modified UTF-7', () => {
  for (const n of ['INBOX', 'Clients été', 'R&D', 'Входящие', '日本語/下書き']) assert.equal(utf7Decode(utf7Encode(n)), n, n);
  assert.equal(utf7Encode('R&D'), 'R&-D');
  assert.equal(utf7Decode('Clients &AOk-t&AOk-'), 'Clients été');
});

test('encoded words, quoted-printable Latin-1, an RFC 2231 file name; the epilogue is not body text', () => {
  assert.equal(decodeWords('=?UTF-8?Q?R=C3=A9union_jeudi?='), 'Réunion jeudi');
  assert.equal(decodeWords('=?UTF-8?B?w4lsb2RpZQ==?= =?UTF-8?B?IE1hcnRpbg==?='), 'Élodie Martin', 'adjacent encoded words join without the space');
  assert.equal(headerParams("attachment; filename*=utf-8''devis%20r%C3%A9vis%C3%A9.pdf").params.filename, 'devis révisé.pdf');
  assert.equal(headerParams('attachment; filename*0*=utf-8\'\'r%C3%A9; filename*1=sum%C3%A9.pdf').params.filename, 'résum%C3%A9.pdf', 'an unencoded continuation stays as written');
  const raw = 'Content-Type: multipart/mixed; boundary="B"\r\n\r\npre\r\n--B\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nla r=E9union\r\n--B\r\nContent-Type: application/pdf; name="q.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--B--\r\nepilogue\r\n';
  const out = walkMessage(raw);
  assert.deepEqual(out.plain, ['la réunion']);
  assert.deepEqual(out.attachments, [{ filename: 'q.pdf', type: 'application/pdf', size: 9 }]);
  assert.match(htmlToText('<style>x{}</style><p>Hi&nbsp;Mel</p><p>Line 2 &amp; more</p>'), /^Hi Mel\nLine 2 & more$/);
});

test('a draft is plain text in base64 with encoded headers; a new line in a header is refused', () => {
  const raw = buildDraft({ from: 'Mel Driftwood <mel@driftwood.test>', to: ['Élodie <elodie@exemple.fr>'], subject: 'Re: Réunion', body: 'Merci,\nMel', inReplyTo: '<fr42@exemple.fr>', references: '<older@exemple.fr> <fr42@exemple.fr>' }).toString();
  assert.match(raw, /^From: "Mel Driftwood" <mel@driftwood\.test>\r\n/);
  assert.match(raw, /\r\nTo: =\?UTF-8\?B\?w4lsb2RpZQ==\?= <elodie@exemple\.fr>\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\nIn-Reply-To: <fr42@exemple\.fr>\r\nReferences: <older@exemple\.fr> <fr42@exemple\.fr>\r\n/);
  assert.match(raw, /Message-ID: <[0-9a-f]{24}@driftwood\.test>/);
  const body = raw.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), 'Merci,\r\nMel');
  assert.throws(() => buildDraft({ from: 'a@b.test', to: ['c@d.test'], subject: 'hi\r\nBcc: everyone@x.test', body: '' }), /more than one line/);
  assert.throws(() => addressList(['ok@x.test', 'Eve <e@x.test>\r\nBcc: z@x.test']), /doesn't look like an email address/);
  assert.deepEqual(addressList('a@x.test, "Smith, Jo" <jo@x.test>'), ['a@x.test', '"Smith, Jo" <jo@x.test>'], 'a comma inside quotes is part of the name');
  assert.equal(imapDate('2026-11-05', 'since'), '5-Nov-2026');
  assert.throws(() => imapDate('5/11/2026', 'since'), /like 2026-11-05/);
});

test('nothing in the tool table sends, deletes, moves or marks', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['account_info', 'list_folders', 'search_mail', 'read_message', 'save_draft']);
  for (const n of names) assert.doesNotMatch(n, /(send|delete|remove|move|trash|flag|mark|expunge|smtp)/, n);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', `${t.name} has an object schema`);
  assert.match(TOOLS.find((t) => t.name === 'save_draft').description, /NOTHING IS SENT/);
});

test('plain IMAP is only ever to this machine', async () => {
  await assert.rejects(openConnection({ host: 'mail.example.com', port: 143, security: 'none' }), /only ever made over TLS/);
});

// ---- the server over stdio, against the fake ---------------------------------

function mcp(env) {
  const p = spawn('node', [SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; const waiting = new Map(); let id = 0;
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const text = m.result.content[0].text;
    return m.result.isError ? { error: text } : JSON.parse(text);
  };
  return { rpc, call, stop: () => p.kill() };
}
const envFor = (port, extra = {}) => ({ IMAP_HOST: '127.0.0.1', IMAP_PORT: String(port), IMAP_SECURITY: 'none', IMAP_USER: 'mel@driftwood.test', IMAP_PASSWORD: PASS, IMAP_FROM: 'Mel Driftwood <mel@driftwood.test>', ...extra });

test('reads, searches and drafts; never selects read-write, never fetches without PEEK, never stores or deletes', async () => {
  const fake = await startFakeImap({ pass: PASS });
  const s = mcp(envFor(fake.port));
  try {
    const init = await s.rpc('initialize', {});
    assert.equal(init.result.serverInfo.name, 'crads-imap');

    const who = await s.call('account_info');
    assert.deepEqual(who, { account: 'Mel Driftwood <mel@driftwood.test>', server: `127.0.0.1:${fake.port}`, inbox_messages: 2, inbox_unread: 1, folders: 4, drafts_folder: 'Drafts' });
    assert.ok(fake.log.some((l) => /^LOGIN "mel@driftwood\.test" \{LIT0\}$/.test(l)), 'a non-ASCII password travels as a literal, never quoted');

    const folders = await s.call('list_folders');
    assert.deepEqual(folders.map((f) => f.name), ['INBOX', 'Drafts', 'Sent', 'Clients été']);
    assert.equal(folders.find((f) => f.name === 'Drafts').special, 'drafts');

    const all = await s.call('search_mail');
    assert.equal(all.total, 2);
    assert.deepEqual(all.emails.map((e) => e.uid), [7, 3], 'newest first');
    assert.equal(all.emails[0].from, 'Élodie Martin <elodie@exemple.fr>');
    assert.equal(all.emails[0].subject, 'Réunion jeudi');
    assert.equal(all.emails[0].unread, true);
    assert.equal(all.emails[1].unread, false);

    const unread = await s.call('search_mail', { unread_only: true, from: 'elodie' });
    assert.deepEqual(unread.emails.map((e) => e.uid), [7]);
    const accent = await s.call('search_mail', { subject: 'réunion' });
    assert.deepEqual(accent.emails.map((e) => e.uid), [7]);
    assert.ok(fake.log.some((l) => /^UID SEARCH CHARSET UTF-8 SUBJECT \{LIT\d+\}$/.test(l)), 'a non-ASCII search term goes as UTF-8 in a literal');

    const msg = await s.call('read_message', { uid: 7 });
    assert.equal(msg.text, 'Bonjour Mel, la réunion est jeudi à 14h.');
    assert.deepEqual(msg.attachments, [{ filename: 'devis révisé.pdf', type: 'application/pdf', size: 9 }]);
    assert.equal(msg.reply_to, undefined, 'a reply-to that only repeats the sender is left out');
    const again = await s.call('search_mail', { unread_only: true });
    assert.deepEqual(again.emails.map((e) => e.uid), [7], 'reading an email did not mark it as read');

    assert.match((await s.call('read_message', { uid: 99 })).error, /no message 99/);
    assert.match((await s.call('search_mail', { folder: 'Nope' })).error, /no folder called "Nope"/);
    assert.match((await s.call('search_mail', { since: 'last week' })).error, /like 2026-11-05/);

    const reply = await s.call('save_draft', { reply_to_uid: 7, body: 'Merci Élodie, jeudi 14h c’est parfait.\nMel' });
    assert.equal(reply.saved, true);
    assert.equal(reply.folder, 'Drafts');
    assert.equal(reply.to, 'Élodie Martin <elodie@exemple.fr>', 'a reply goes to the sender');
    assert.equal(reply.subject, 'Re: Réunion jeudi');
    assert.match(reply.note, /Nothing has been sent/);
    const d = fake.appended[0];
    assert.equal(d.mailbox, 'Drafts');
    assert.equal(d.flags, '\\Draft \\Seen');
    assert.match(d.raw, /\r\nIn-Reply-To: <fr42@exemple\.fr>\r\nReferences: <older@exemple\.fr> <fr42@exemple\.fr>\r\n/, 'threaded under the email it answers');

    assert.match((await s.call('save_draft', { body: 'x' })).error, /Who is this email to/);
    assert.match((await s.call('save_draft', { to: ['not an address'], body: 'x' })).error, /doesn't look like an email address/);
    const fresh = await s.call('save_draft', { to: ['jo@acme.example'], subject: 'Quote: 40 tonnes', body: 'Hi Jo' });
    assert.equal(fresh.uid, 101);

    // the whole session, every command: read-only, PEEK only, nothing destructive
    for (const l of fake.log) {
      assert.doesNotMatch(l, /^(SELECT|STORE|UID STORE|EXPUNGE|UID EXPUNGE|COPY|UID COPY|MOVE|UID MOVE|DELETE|RENAME|CREATE|SUBSCRIBE)\b/i, l);
      if (/FETCH/i.test(l)) assert.doesNotMatch(l.replace(/BODY\.PEEK\[/g, ''), /BODY\[|RFC822(?!\.SIZE)/, `a fetch that would mark the email read: ${l}`);
    }
    assert.ok(fake.log.filter((l) => /^EXAMINE /.test(l)).length >= 5);
    assert.equal(fake.maxOpen, 1, 'one connection at a time');
  } finally { s.stop(); await fake.close(); }
});

test('calls made together still run one connection at a time', async () => {
  const fake = await startFakeImap({ pass: PASS });
  const s = mcp(envFor(fake.port));
  try {
    await s.rpc('initialize', {});
    const outs = await Promise.all([s.call('search_mail'), s.call('list_folders'), s.call('account_info'), s.call('read_message', { uid: 3 })]);
    assert.ok(outs.every((o) => !o.error), JSON.stringify(outs.find((o) => o.error)));
    assert.equal(fake.maxOpen, 1);
  } finally { s.stop(); await fake.close(); }
});

test('a wrong password, an unreachable server and missing settings each read as plain words', async () => {
  const fake = await startFakeImap({ pass: PASS });
  const wrong = mcp(envFor(fake.port, { IMAP_PASSWORD: 'nope' }));
  const gone = mcp(envFor(1));
  const empty = mcp({ IMAP_HOST: '', IMAP_USER: '', IMAP_PASSWORD: '' });
  try {
    for (const s of [wrong, gone, empty]) await s.rpc('initialize', {});
    assert.match((await wrong.call('account_info')).error, /turned the sign-in down[\s\S]*app passwords/);
    assert.match((await gone.call('account_info')).error, /Could not reach your mail server \(127\.0\.0\.1:1\)/);
    assert.match((await empty.call('account_info')).error, /missing its server, username or password/);
  } finally { wrong.stop(); gone.stop(); empty.stop(); await fake.close(); }
});
