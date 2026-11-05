// tests/fake-imap.mjs: a small IMAP server for the email connection's tests.
//
// It speaks just enough IMAP4rev1 for engine/comms/imap-mcp.mjs (CAPABILITY,
// LOGIN, LIST, STATUS, EXAMINE, SELECT, UID SEARCH, UID FETCH, APPEND, LOGOUT)
// over plain TCP on loopback, answers literals the way real servers do, and
// RECORDS every command line, so a test can pin what the client must never
// send (SELECT, STORE, EXPUNGE, COPY, MOVE, DELETE, a FETCH without PEEK).
// It also counts how many connections are open at once.
import net from 'node:net';

const MAILBOXES = ['INBOX', 'Drafts', 'Sent', 'Clients &AOk-t&AOk-']; // the last is "Clients été" in modified UTF-7

export function sampleMessages() {
  return [
    { uid: 3, flags: ['\\Seen'], date: '03-Nov-2026 09:12:00 +1100', raw:
      'From: Jo Bloggs <jo@acme.example>\r\nTo: mel@driftwood.test\r\nSubject: Carbon credits for our offsite\r\n'
      + 'Date: Tue, 3 Nov 2026 09:12:00 +1100\r\nMessage-ID: <abc123@acme.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
      + 'Hi Mel,\r\nCould you send a quote for 40 tonnes? Thanks, Jo\r\n' },
    { uid: 7, flags: [], date: '04-Nov-2026 10:00:00 +0100', raw:
      'From: =?UTF-8?B?w4lsb2RpZSBNYXJ0aW4=?= <elodie@exemple.fr>\r\nTo: mel@driftwood.test\r\nSubject: =?UTF-8?Q?R=C3=A9union_jeudi?=\r\n'
      + 'Date: Wed, 4 Nov 2026 10:00:00 +0100\r\nMessage-ID: <fr42@exemple.fr>\r\nReferences: <older@exemple.fr>\r\nMIME-Version: 1.0\r\n'
      + 'Content-Type: multipart/mixed; boundary="XX1"\r\n\r\npreamble\r\n--XX1\r\nContent-Type: text/plain; charset=iso-8859-1\r\n'
      + 'Content-Transfer-Encoding: quoted-printable\r\n\r\nBonjour Mel, la r=E9union est jeudi =E0 14h.\r\n--XX1\r\n'
      + 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*=utf-8\'\'devis%20r%C3%A9vis%C3%A9.pdf\r\n'
      + 'Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--XX1--\r\nepilogue that must not show\r\n' },
  ];
}

const q = (s) => (s == null ? 'NIL' : '"' + String(s).replace(/[\\"]/g, '\\$&') + '"');
const header = (raw, name) => (raw.match(new RegExp('^' + name + ':\\s*(.*)$', 'mi')) || [])[1] || null;
const addr = (v) => {
  if (!v) return 'NIL';
  const m = v.match(/^\s*(.*?)\s*<([^@>]+)@([^>]+)>\s*$/) || [null, '', ...v.split('@')];
  return `((${m[1] ? q(m[1]) : 'NIL'} NIL ${q(m[2])} ${q(m[3])}))`;
};
const envelope = (raw) => `(${q(header(raw, 'Date'))} ${q(header(raw, 'Subject'))} ${addr(header(raw, 'From'))} ${addr(header(raw, 'From'))} ${addr(header(raw, 'From'))} ${addr(header(raw, 'To'))} NIL NIL NIL ${q(header(raw, 'Message-ID'))})`;

export function startFakeImap({ user = 'mel@driftwood.test', pass = 'app-pässword', messages = sampleMessages() } = {}) {
  const log = []; let open = 0; let maxOpen = 0; const appended = [];
  const boxes = { INBOX: messages.map((m) => ({ ...m })), Drafts: [], Sent: [], [MAILBOXES[3]]: [] };
  const server = net.createServer((sock) => {
    open++; maxOpen = Math.max(maxOpen, open);
    // gone once the client has said goodbye (its FIN, 'end'), not when this
    // side finishes tearing down ('close'): the client waits for its own close
    // before it opens the next connection, and on a fast CI runner the next
    // connect can land before this side's 'close' fires (found 2026-11-05,
    // public CI: maxOpen 2 though the client never overlapped)
    let gone = false;
    const leave = () => { if (!gone) { gone = true; open--; } };
    sock.on('end', leave); sock.on('close', leave);   // and on LOGOUT, below
    let buf = Buffer.alloc(0); let authed = false; let selected = null;
    let pending = null;   // { tag, line, need, parts } while a literal is coming
    const w = (s) => sock.write(s + '\r\n');
    w('* OK [CAPABILITY IMAP4rev1 UIDPLUS SPECIAL-USE] fake ready');
    const run = (tag, line, lits) => {
      log.push(line);
      const cmd = line.split(' ')[0].toUpperCase();
      const rest = line.slice(cmd.length + 1);
      const arg = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);
      if (cmd === 'CAPABILITY') { w('* CAPABILITY IMAP4rev1 UIDPLUS SPECIAL-USE'); return w(`${tag} OK done`); }
      if (cmd === 'LOGOUT') { leave(); w('* BYE'); w(`${tag} OK bye`); return sock.end(); }   // said goodbye: no longer counted
      if (cmd === 'LOGIN') {
        // a literal arrives as {LIT0}, {LIT1} in the logged line
        const toks = rest.match(/"(?:[^"\\]|\\.)*"|\{LIT\d+\}|\S+/g) || [];
        const val = (t) => (/^\{LIT(\d+)\}$/.test(t) ? lits[Number(t.slice(4, -1))].toString('utf8') : arg(t));
        if (val(toks[0]) === user && val(toks[1]) === pass) { authed = true; return w(`${tag} OK logged in`); }
        return w(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.`);
      }
      if (!authed) return w(`${tag} BAD sign in first`);
      if (cmd === 'LIST') {
        w('* LIST (\\HasNoChildren) "/" INBOX');
        w('* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"');
        w('* LIST (\\HasNoChildren \\Sent) "/" Sent');
        w(`* LIST (\\HasNoChildren) "/" "${MAILBOXES[3]}"`);
        return w(`${tag} OK done`);
      }
      if (cmd === 'STATUS') { const n = boxes.INBOX.length; const u = boxes.INBOX.filter((m) => !m.flags.includes('\\Seen')).length; w(`* STATUS INBOX (MESSAGES ${n} UNSEEN ${u})`); return w(`${tag} OK done`); }
      if (cmd === 'EXAMINE' || cmd === 'SELECT') {
        const name = arg(rest);
        if (!boxes[name]) return w(`${tag} NO [NONEXISTENT] Mailbox doesn't exist: ${name}`);
        selected = name; w(`* ${boxes[name].length} EXISTS`);
        return w(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done`);
      }
      if (cmd === 'UID') {
        const sub = rest.split(' ')[0].toUpperCase(); const after = rest.slice(sub.length + 1);
        const box = boxes[selected] || [];
        if (sub === 'SEARCH') {
          let hits = box;
          const from = after.match(/FROM "([^"]*)"/i); if (from) hits = hits.filter((m) => (header(m.raw, 'From') || '').toLowerCase().includes(from[1].toLowerCase()));
          if (/\bUNSEEN\b/i.test(after)) hits = hits.filter((m) => !m.flags.includes('\\Seen'));
          if (/\{LIT\d+\}/.test(after)) hits = hits.filter((m) => /R=C3=A9union/.test(m.raw));   // the one non-ASCII search the tests make
          w('* SEARCH' + hits.map((m) => ' ' + m.uid).join(''));
          return w(`${tag} OK done`);
        }
        if (sub === 'FETCH') {
          const set = after.split(' ')[0].split(',').map(Number);
          const items = after.slice(after.indexOf(' ') + 1);
          box.filter((m, i) => set.includes(m.uid) && (m.seq = i + 1)).forEach((m) => {
            const raw = Buffer.from(m.raw, 'utf8');
            let line = `* ${m.seq} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}) INTERNALDATE "${m.date}" RFC822.SIZE ${raw.length}`;
            if (/ENVELOPE/.test(items)) line += ` ENVELOPE ${envelope(m.raw)}`;
            if (/BODY\.PEEK\[HEADER\.FIELDS \(REFERENCES\)\]/.test(items)) {
              const h = Buffer.from((header(m.raw, 'References') ? `References: ${header(m.raw, 'References')}\r\n` : '') + '\r\n');
              sock.write(line + ` BODY[HEADER.FIELDS (REFERENCES)] {${h.length}}\r\n`); sock.write(h); line = '';
            }
            if (/BODY\.PEEK\[\]/.test(items)) { sock.write(line + ` BODY[]<0> {${raw.length}}\r\n`); sock.write(raw); line = ''; }
            if (/BODY\[\]/.test(items.replace(/BODY\.PEEK\[/g, ''))) m.flags.push('\\Seen');   // a fetch without PEEK marks it read, as real servers do
            w(line + ')');
          });
          return w(`${tag} OK done`);
        }
      }
      if (cmd === 'APPEND') {
        const name = arg(rest.match(/^("(?:[^"\\]|\\.)*"|\S+)/)[1]);
        if (!boxes[name]) return w(`${tag} NO [TRYCREATE] no such mailbox`);
        const flags = (rest.match(/\(([^)]*)\)/) || [])[1] || '';
        const uid = 100 + appended.length;
        const rawMsg = lits[lits.length - 1].toString('utf8');
        appended.push({ mailbox: name, flags, raw: rawMsg });
        boxes[name].push({ uid, flags: flags.split(' ').filter(Boolean), date: '05-Nov-2026 06:00:00 +0000', raw: rawMsg });
        return w(`${tag} OK [APPENDUID 1 ${uid}] Append completed.`);
      }
      return w(`${tag} BAD unknown command ${cmd}`);
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (pending && pending.need >= 0) {
          if (buf.length < pending.need) return;
          pending.parts.push(buf.subarray(0, pending.need)); buf = buf.subarray(pending.need); pending.need = -1;
          continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 2);
        const lit = line.match(/\{(\d+)\}$/);
        if (!pending) {
          const sp = line.indexOf(' ');
          pending = { tag: line.slice(0, sp), line: '', need: -1, parts: [] };
          pending.line = line.slice(sp + 1);
        } else pending.line += line;
        if (lit) {
          pending.line = pending.line.replace(/\{(\d+)\}$/, `{LIT${pending.parts.length}}`);
          pending.need = Number(lit[1]); w('+ go ahead');
          continue;
        }
        const p = pending; pending = null;
        run(p.tag, p.line, p.parts);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, log, appended, boxes,
    get maxOpen() { return maxOpen; },
    close: () => new Promise((r) => server.close(() => r())),
  })));
}
