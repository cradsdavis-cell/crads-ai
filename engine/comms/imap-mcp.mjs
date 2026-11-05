#!/usr/bin/env node
// imap-mcp.mjs: an email connection over IMAP that runs ON THE MINERAL.
//
// WHY THIS EXISTS (2026-11-05, first asked for at the first drop-in). Plenty of
// small businesses keep their mail with a web host or a mail provider that is
// neither Google nor Microsoft, often because those charge per mailbox. Every
// one of them speaks IMAP, but there is no one hosted server to list, and the
// community IMAP servers relay a member's mailbox through somebody else's
// machines. So, as with Mailchimp and Odoo, the member types their mail
// server's settings and their own (app) password, they live on their mineral,
// and this small server, run by Claude Code over stdio, is the only thing that
// ever holds them. Zero dependencies: IMAP is a text protocol over TLS, and
// node's tls module is all it needs.
//
// WHAT IT WILL NOT DO, ON PURPOSE.
//   - Send anything. There is no SMTP here at all. A reply or a new email is
//     saved to the member's Drafts folder, where their mail app shows it, and
//     the member presses Send there. An email cannot be taken back.
//   - Delete, move, flag or mark anything. Folders are opened read-only
//     (EXAMINE) and messages are read with BODY.PEEK, so reading a message
//     does not even mark it as read.
//   - Cross the internet in the clear. The connection is TLS (port 993) or
//     STARTTLS, with the server's certificate checked; plain IMAP is allowed
//     only to this machine (tests).
//
// Settings (written by mcp-connect.mjs add-imap into the box's .mcp.json):
//   IMAP_HOST       the mail server, e.g. mail.example.com
//   IMAP_PORT       optional, default 993 (143 with STARTTLS)
//   IMAP_SECURITY   optional: tls (default) | starttls | none (loopback only)
//   IMAP_USER       the sign-in name, usually the full email address
//   IMAP_PASSWORD   the password, or an app password where the provider has them
//   IMAP_FROM       optional: the address a draft is from (default IMAP_USER)
//   IMAP_DRAFTS     optional: the drafts folder, when the server doesn't mark one
//
// One connection per tool call, opened, signed in, used and closed, and calls
// run ONE AT A TIME: mail hosts cap simultaneous connections per mailbox, and
// the member's phone and laptop already hold some of them.
//
//   IMAP_HOST=... IMAP_USER=... IMAP_PASSWORD=... node imap-mcp.mjs   (stdio MCP server)
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isMain } from '../lib/is-main.mjs';

export const SERVER = { name: 'crads-imap', version: '1.0.0' };
const PROTOCOL = '2025-06-18';
const MAX_FETCH = 5 * 1024 * 1024;   // read at most the first 5 MB of a message
const MAX_TEXT = 20000;              // characters of body text in one answer
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

// ---- plain words for each way it can go wrong --------------------------------

export class MailError extends Error {
  constructor(message, problem = 'other') { super(message); this.problem = problem; }
}
export const WORDS = {
  auth: 'Your mail server turned the sign-in down. Check the username and password on the Connections page. If your provider uses app passwords (iCloud, Yahoo, Fastmail and Zoho do), make one there and paste that instead of your normal password.',
  unreachable: (where) => `Could not reach your mail server (${where}). Check the server name and port on the Connections page; your provider's help pages list them as the "incoming mail (IMAP)" settings.`,
  certificate: (where) => `Your mail server's security certificate didn't check out (${where}), so nothing was sent to it. Check the server name: it must be the one on the certificate, which is often your provider's own name (like mail.yourhost.com) rather than your domain.`,
  timeout: 'Your mail server took too long to answer. Try again in a minute.',
  disabled: 'Your mail server does not allow signing in with a password on this connection. Ask your provider whether IMAP access needs turning on for the mailbox.',
};

// ---- modified UTF-7, the encoding IMAP uses for folder names (RFC 3501 5.1.3) --

export function utf7Encode(s) {
  return String(s).replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    return '&' + b.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
  });
}
export function utf7Decode(s) {
  return String(s).replace(/&([^-]*)-/g, (_, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b.readUInt16BE(i));
    return out;
  });
}

// ---- the wire: responses as text parts and literal byte strings ---------------

// Splits the server's byte stream into whole responses. A response is one line,
// except that a line ending in {n} is followed by exactly n bytes of literal
// data and then carries on. Each response comes out as [text, Buffer, text...].
export class Reader {
  constructor(onResponse) { this.buf = Buffer.alloc(0); this.parts = []; this.want = -1; this.onResponse = onResponse; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.want >= 0) {
        if (this.buf.length < this.want) return;
        this.parts.push(this.buf.subarray(0, this.want));
        this.buf = this.buf.subarray(this.want);
        this.want = -1;
        continue;
      }
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 2);
      const lit = line.match(/\{(\d+)\+?\}$/);
      if (lit) { this.parts.push(line.slice(0, lit.index)); this.want = Number(lit[1]); continue; }
      this.parts.push(line);
      const done = this.parts; this.parts = [];
      this.onResponse(done);
    }
  }
}

// Turns a response's parts into nested values: lists become arrays, quoted
// strings and atoms become strings, NIL becomes null, literals stay Buffers.
// An atom like BODY[HEADER] or BODY[]<0> keeps its brackets.
export function parseParts(parts) {
  const root = []; const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const p of parts) {
    if (Buffer.isBuffer(p)) { top().push(p); continue; }
    let i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === ' ') { i++; continue; }
      if (c === '(') { const l = []; top().push(l); stack.push(l); i++; continue; }
      if (c === ')') { if (stack.length > 1) stack.pop(); i++; continue; }
      if (c === '"') {
        let s = ''; i++;
        while (i < p.length && p[i] !== '"') { if (p[i] === '\\' && i + 1 < p.length) i++; s += p[i++]; }
        i++; top().push(s); continue;
      }
      let j = i; let depth = 0;
      while (j < p.length) {
        const d = p[j];
        if (d === '[') depth++;
        else if (d === ']') depth--;
        else if (depth <= 0 && (d === ' ' || d === '(' || d === ')')) break;
        j++;
      }
      const atom = p.slice(i, j);
      top().push(atom.toUpperCase() === 'NIL' ? null : atom);
      i = j;
    }
  }
  return root;
}

const text = (v) => (v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

// A string as IMAP wants it: quoted when it is plain printable ASCII, or a
// literal (its bytes, sent after the server says go ahead) when it is not.
export function astring(s) {
  const v = String(s);
  if (/^[\x20-\x7e]*$/.test(v) && v.length < 1000) return '"' + v.replace(/[\\"]/g, '\\$&') + '"';
  return Buffer.from(v, 'utf8');
}

// ---- one connection ----------------------------------------------------------

export async function openConnection({ host, port, security = 'tls', timeoutMs = 30000 } = {}) {
  const where = `${host}:${port}`;
  if (security === 'none' && !LOOPBACK.test(String(host))) throw new MailError('A mail connection is only ever made over TLS.', 'other');
  const connectRaw = () => new Promise((resolve, reject) => {
    const s = security === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' })
      : net.connect({ host, port });
    const ev = security === 'tls' ? 'secureConnect' : 'connect';
    s.once(ev, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeoutMs, () => s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
  const translate = (e) => {
    if (e instanceof MailError) return e;
    const code = String(e?.code || '');
    if (code === 'ETIMEDOUT') return new MailError(WORDS.timeout, 'unreachable');
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT|HOSTNAME|ALTNAME/i.test(code + ' ' + e?.message)) return new MailError(WORDS.certificate(where), 'certificate');
    return new MailError(WORDS.unreachable(where), 'unreachable');
  };
  let sock;
  try { sock = await connectRaw(); } catch (e) { throw translate(e); }

  let reader; let waiting = null; const queue = [];
  let closedErr = null;
  const deliver = (parts) => { if (waiting) { const w = waiting; waiting = null; w.resolve(parts); } else queue.push(parts); };
  const attach = (s) => {
    reader = new Reader(deliver);
    s.on('data', (d) => reader.push(d));
    s.on('error', (e) => { closedErr = translate(e); if (waiting) { const w = waiting; waiting = null; w.reject(closedErr); } });
    s.on('close', () => { closedErr = closedErr || new MailError(WORDS.unreachable(where), 'unreachable'); if (waiting) { const w = waiting; waiting = null; w.reject(closedErr); } });
  };
  attach(sock);
  const next = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closedErr) return Promise.reject(closedErr);
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };

  let tagN = 0;
  // Sends one command and collects its untagged responses until the tagged
  // reply. `pieces` mixes strings and Buffers; a Buffer travels as a literal.
  const command = async (...pieces) => {
    const tag = 'C' + (++tagN);
    let line = tag;
    for (const p of pieces) {
      if (Buffer.isBuffer(p)) {
        sock.write(line + ` {${p.length}}\r\n`);
        const go = await next();
        if (!String(go[0] || '').startsWith('+')) throw new MailError(`Your mail server refused that: ${text(go[0]).slice(0, 200)}`);
        sock.write(p);
        line = '';
      } else line += ' ' + p;
    }
    sock.write(line + '\r\n');
    const untagged = [];
    for (;;) {
      const r = await next();
      const head = text(r[0]);
      if (head.startsWith(tag + ' ')) {
        const m = head.slice(tag.length + 1).match(/^(OK|NO|BAD)\b\s*(.*)$/i) || [null, 'BAD', head];
        return { status: m[1].toUpperCase(), info: m[2], untagged };
      }
      if (head.startsWith('+')) continue;   // a stray go-ahead
      untagged.push(r);
    }
  };

  const greet = text((await next())[0]);
  if (/^\* BYE/i.test(greet)) { sock.destroy(); throw new MailError(`Your mail server closed the connection: ${greet.slice(6, 200)}`, 'unreachable'); }
  if (security === 'starttls') {
    const r = await command('STARTTLS');
    if (r.status !== 'OK') { sock.destroy(); throw new MailError('Your mail server would not start a secure connection on that port. Try port 993 with "secure connection (TLS)".', 'unreachable'); }
    sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close');
    try {
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' });
        t.once('secureConnect', () => resolve(t)); t.once('error', reject);
      });
    } catch (e) { throw translate(e); }
    attach(sock);
  }
  return {
    command,
    preauth: /^\* PREAUTH/i.test(greet),
    // LOGOUT, then wait for the socket to close (or give up after a second),
    // so the next call never overlaps it: hosts cap connections per mailbox
    close: () => new Promise((resolve) => {
      if (sock.destroyed) return resolve();
      const t = setTimeout(() => { sock.destroy(); resolve(); }, 1000); t.unref?.();
      sock.once('close', () => { clearTimeout(t); resolve(); });
      try { sock.end(`C${++tagN} LOGOUT\r\n`); } catch { sock.destroy(); }
    }),
  };
}

// ---- reading the answers -----------------------------------------------------

// RFC 2047 encoded words (=?utf-8?B?...?=), as subjects and names come.
export function decodeWords(s) {
  return String(s ?? '').replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, cs, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decodeCharset(bytes, cs.replace(/\*.*$/, ''));
    } catch { return all; }
  });
}
export function decodeCharset(bytes, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

const addresses = (list) => (Array.isArray(list) ? list : []).map((a) => {
  if (!Array.isArray(a)) return null;
  const name = decodeWords(text(a[0])); const box = text(a[2]); const host = text(a[3]);
  const email = box && host ? `${box}@${host}` : box;
  return name ? `${name} <${email}>` : email;
}).filter(Boolean);

// One FETCH response's attribute list as a plain object, keys upper-cased.
export function fetchAttrs(resp) {
  const items = parseParts(resp);
  // * <n> FETCH (...)
  const list = items.find((x) => Array.isArray(x)) || [];
  const o = {};
  for (let i = 0; i + 1 < list.length; i += 2) o[String(list[i]).toUpperCase()] = list[i + 1];
  return o;
}

export function envelope(env) {
  if (!Array.isArray(env)) return {};
  return {
    date: text(env[0]) || undefined,
    subject: decodeWords(text(env[1])),
    from: addresses(env[2]),
    reply_to: addresses(env[4]),
    to: addresses(env[5]),
    cc: addresses(env[6]),
    in_reply_to: text(env[8]) || undefined,
    message_id: text(env[9]) || undefined,
  };
}

// ---- a message, taken apart --------------------------------------------------

export function parseHeaders(raw) {
  const h = {};
  const unfolded = String(raw).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):\s*(.*)$/);
    if (m) (h[m[1].toLowerCase()] ||= []).push(m[2]);
  }
  return h;
}
const first = (h, k) => (h[k] ? h[k][0] : '');

// "text/plain; charset=utf-8; name*=utf-8''r%C3%A9sum%C3%A9.pdf"
export function headerParams(v) {
  const parts = String(v || '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const value = parts.shift().trim().toLowerCase();
  const params = {}; const ext = {};   // ext: RFC 2231 pieces, name*0*, name*1...
  for (const p of parts) {
    const m = p.match(/^\s*([^=\s]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v2 = m[2].trim().replace(/^"(.*)"$/s, '$1');
    const x = k.match(/^([^*]+)\*(?:(\d+)\*?)?$/);
    if (x) (ext[x[1]] ||= []).push({ n: Number(x[2] || 0), v: v2, encoded: k.endsWith('*') });
    else if (!(k in params)) params[k] = decodeWords(v2);
  }
  for (const [k, pieces] of Object.entries(ext)) {
    pieces.sort((a, b) => a.n - b.n);
    let charset = 'utf-8'; let bytes = '';
    for (const [i, pc] of pieces.entries()) {
      let v = pc.v;
      if (i === 0 && pc.encoded) { const y = v.match(/^([^']*)'[^']*'(.*)$/); if (y) { charset = y[1] || charset; v = y[2]; } }
      bytes += pc.encoded ? v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : v;
    }
    params[k] = decodeCharset(Buffer.from(bytes, 'latin1'), charset);
  }
  return { value, params };
}

function decodeTransfer(binary, enc) {
  const e = String(enc || '').trim().toLowerCase();
  if (e === 'base64') return Buffer.from(binary.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    return Buffer.from(binary.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), 'latin1');
  }
  return Buffer.from(binary, 'latin1');
}

// Walks a raw message (as a latin1 string, one char per byte) and collects the
// plain-text and HTML bodies and the attachments' names, types and sizes.
export function walkMessage(raw, out = { plain: [], html: [], attachments: [] }, depth = 0) {
  const sep = raw.search(/\r?\n\r?\n/);
  const head = sep < 0 ? raw : raw.slice(0, sep);
  const body = sep < 0 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');
  const h = parseHeaders(head);
  const ct = headerParams(first(h, 'content-type') || 'text/plain');
  const cd = headerParams(first(h, 'content-disposition'));
  const filename = cd.params.filename || ct.params.name;
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 20) {
    const b = ('--' + ct.params.boundary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the parts sit between the first boundary line and the closing one (--b--);
    // the preamble before and the epilogue after are not part of the message
    const end = body.search(new RegExp('(?:^|\\r?\\n)' + b + '--'));
    const inner = end >= 0 ? body.slice(0, end) : body;
    const chunks = inner.split(new RegExp('(?:^|\\r?\\n)' + b + '[ \\t]*(?:\\r?\\n|$)'));
    for (const c of chunks.slice(1)) if (c.trim()) walkMessage(c, out, depth + 1);
    return out;
  }
  const bytes = decodeTransfer(body, first(h, 'content-transfer-encoding'));
  if (cd.value === 'attachment' || filename || !ct.value.startsWith('text/')) {
    if (depth > 0 || filename) out.attachments.push({ filename: filename || '(unnamed)', type: ct.value, size: bytes.length });
    return out;
  }
  const t = decodeCharset(bytes, ct.params.charset);
  if (ct.value === 'text/html') out.html.push(t); else out.plain.push(t);
  return out;
}

export function htmlToText(html) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ent[e.toLowerCase()] ?? all))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- building a draft --------------------------------------------------------

const ADDR_RE = /^(?:[^<>\r\n]*<\s*[^\s@<>]+@[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>]+)$/;
export function addressList(v, field) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((x) => String(x).trim()).filter(Boolean);
  for (const a of list) if (!ADDR_RE.test(a)) throw new MailError(`"${a.slice(0, 80)}" in ${field} doesn't look like an email address.`);
  return list;
}
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const encodeAddress = (a) => {
  const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1] ? `${/^[\x20-\x7e]*$/.test(m[1]) ? `"${m[1].replace(/["\\]/g, '')}"` : encodeHeader(m[1])} <${m[2].trim()}>` : a.replace(/^.*<([^>]+)>.*$/, '$1');
};
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

export function buildDraft({ from, to = [], cc = [], subject = '', body = '', inReplyTo, references, now = new Date() }) {
  for (const v of [subject, inReplyTo, references]) if (/[\r\n]/.test(String(v || ''))) throw new MailError('A subject or reference cannot run over more than one line.');
  const domain = (String(from).match(/@([^>\s]+)/) || [])[1] || 'localhost';
  const lines = [
    `From: ${encodeAddress(from)}`,
    ...(to.length ? [`To: ${to.map(encodeAddress).join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeader(String(subject))}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const text8 = String(body).replace(/\r?\n/g, '\r\n');
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + wrap76(Buffer.from(text8, 'utf8').toString('base64')), 'utf8');
}

// IMAP dates: 5-Nov-2026
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function imapDate(s, field) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new MailError(`${field} should be a date like 2026-11-05.`);
  return `${Number(m[3])}-${MON[Number(m[2]) - 1]}-${m[1]}`;
}

// ---- the client: one tool call = one signed-in session -----------------------

export function createClient({ host, port, security, user, pass, from, drafts, timeoutMs = 60000 } = {}) {
  const sec = ['tls', 'starttls', 'none'].includes(String(security || '').toLowerCase()) ? String(security).toLowerCase() : 'tls';
  const p = Number(port) || (sec === 'starttls' ? 143 : sec === 'none' ? 143 : 993);
  let chain = Promise.resolve();
  const session = (fn) => {
    const run = async () => {
      if (!host || !user || !pass) throw new MailError('This email connection is missing its server, username or password. Set it up again on the Connections page.', 'auth');
      const c = await openConnection({ host, port: p, security: sec, timeoutMs });
      const timer = setTimeout(() => c.close(), timeoutMs); timer.unref?.();
      try {
        if (!c.preauth) {
          const caps = await c.command('CAPABILITY');
          const capLine = caps.untagged.map((r) => text(r[0])).join(' ');
          if (/LOGINDISABLED/i.test(capLine)) throw new MailError(WORDS.disabled, 'auth');
          const r = await c.command('LOGIN', astring(user), astring(pass));
          if (r.status !== 'OK') throw new MailError(WORDS.auth, 'auth');
        }
        return await fn(c);
      } finally { clearTimeout(timer); await c.close(); }
    };
    const out = chain.then(run, run);
    chain = out.catch(() => {});
    return out;
  };
  const ok = (r, what) => { if (r.status !== 'OK') throw new MailError(`Your mail server said no to ${what}: ${r.info.slice(0, 200)}`); return r; };

  const listFolders = async (c) => {
    const r = ok(await c.command('LIST', '""', '"*"'), 'listing folders');
    return r.untagged.map((resp) => {
      const v = parseParts(resp);   // * LIST (\HasNoChildren \Drafts) "/" "Drafts"
      if (String(v[1]).toUpperCase() !== 'LIST') return null;
      const attrs = (Array.isArray(v[2]) ? v[2] : []).map(String);
      const raw = text(v[4]);
      return { name: utf7Decode(raw), raw, special: (attrs.find((a) => /^\\(Drafts|Sent|Trash|Junk|Archive|All|Flagged)$/i.test(a)) || '').slice(1).toLowerCase() || undefined, selectable: !attrs.some((a) => /^\\Noselect$/i.test(a)) };
    }).filter(Boolean);
  };
  const draftsFolder = async (c) => {
    if (drafts) return { name: drafts, raw: utf7Encode(drafts) };
    const all = await listFolders(c);
    return all.find((f) => f.special === 'drafts')
      || all.find((f) => /(^|[./])drafts?$/i.test(f.name) && f.selectable)
      || null;
  };
  const examine = async (c, folder) => {
    const name = folder ? String(folder) : 'INBOX';
    const r = await c.command('EXAMINE', astring(utf7Encode(name)));
    if (r.status !== 'OK') throw new MailError(`There's no folder called "${name.slice(0, 80)}" in this mailbox (list_folders shows the names).`);
    return name;
  };
  const fetchOne = async (c, uid, items) => {
    if (!Number.isInteger(uid) || uid < 1) throw new MailError('uid should be a message number from search_mail.');
    const r = ok(await c.command('UID FETCH', String(uid), items), 'fetching that message');
    const resp = r.untagged.find((x) => /^\* \d+ FETCH/i.test(text(x[0])));
    if (!resp) throw new MailError(`There's no message ${uid} in that folder any more (it may have been moved or deleted).`);
    return fetchAttrs(resp);
  };

  return {
    session, listFolders, draftsFolder, examine, fetchOne, ok,
    from: from || user, host, port: p, user,
  };
}

// ---- the tools ---------------------------------------------------------------

const str = (description) => ({ type: 'string', description });
const req = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const FOLDER = str('Optional: the folder, as list_folders names it. Default INBOX.');
const UID = { type: 'integer', minimum: 1, description: 'The message number (uid) from search_mail.' };

export const TOOLS = [
  {
    name: 'account_info',
    description: 'Which mailbox this is: the address, the mail server, how many messages are in the inbox and how many unread, and which folder drafts are saved to.',
    inputSchema: req({}, []),
    run: async (cl) => cl.session(async (c) => {
      const st = await c.command('STATUS', 'INBOX', '(MESSAGES UNSEEN)');
      const line = st.untagged.map((r) => text(r.join(' '))).join(' ');
      const n = (k) => { const m = line.match(new RegExp(k + '\\s+(\\d+)', 'i')); return m ? Number(m[1]) : undefined; };
      const folders = await cl.listFolders(c);
      const d = await cl.draftsFolder(c);
      return { account: cl.from, server: `${cl.host}:${cl.port}`, inbox_messages: n('MESSAGES'), inbox_unread: n('UNSEEN'), folders: folders.length, drafts_folder: d?.name || null };
    }),
  },
  {
    name: 'list_folders',
    description: 'Every folder in the mailbox, with the special ones (drafts, sent, trash, junk, archive) marked.',
    inputSchema: req({}, []),
    run: async (cl) => cl.session(async (c) => (await cl.listFolders(c)).map(({ name, special, selectable }) => ({ name, ...(special ? { special } : {}), ...(selectable ? {} : { selectable: false }) }))),
  },
  {
    name: 'search_mail',
    description: 'Find emails in one folder, newest first: by who sent them, who they went to, words in the subject or anywhere in the message, a date range, or only the unread ones. With no filters, the most recent emails. Reading the list marks nothing as read.',
    inputSchema: req({
      folder: FOLDER,
      from: str('Optional: part of the sender\'s name or address.'),
      to: str('Optional: part of a recipient\'s name or address.'),
      subject: str('Optional: words in the subject.'),
      text: str('Optional: words anywhere in the email.'),
      since: str('Optional: on or after this date, YYYY-MM-DD.'),
      before: str('Optional: before this date, YYYY-MM-DD.'),
      unread_only: { type: 'boolean', description: 'Optional: only emails not yet read.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional, default 20.' },
    }, []),
    run: async (cl, a) => cl.session(async (c) => {
      const folder = await cl.examine(c, a.folder);
      const crit = []; let utf8 = false;
      const add = (key, v) => { if (v === undefined || v === null || v === '') return; const s = astring(v); if (Buffer.isBuffer(s)) utf8 = true; crit.push(key, s); };
      add('FROM', a.from); add('TO', a.to); add('SUBJECT', a.subject); add('TEXT', a.text);
      // SENT*: by the date on the email, which is what a person means by "last week"
      if (a.since) crit.push('SENTSINCE', imapDate(a.since, 'since'));
      if (a.before) crit.push('SENTBEFORE', imapDate(a.before, 'before'));
      if (a.unread_only) crit.push('UNSEEN');
      if (!crit.length) crit.push('ALL');
      const r = cl.ok(await c.command('UID SEARCH', ...(utf8 ? ['CHARSET', 'UTF-8'] : []), ...crit), 'that search');
      const uids = r.untagged.flatMap((x) => { const m = text(x[0]).match(/^\* SEARCH\s*(.*)$/i); return m ? m[1].trim().split(/\s+/).filter(Boolean).map(Number) : []; })
        .filter(Number.isInteger).sort((x, y) => y - x);
      const pick = uids.slice(0, a.limit || 20);
      if (!pick.length) return { folder, total: 0, emails: [] };
      const f = cl.ok(await c.command('UID FETCH', pick.join(','), '(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)'), 'reading the list');
      const rows = f.untagged.filter((x) => /^\* \d+ FETCH/i.test(text(x[0]))).map((x) => {
        const o = fetchAttrs(x); const e = envelope(o.ENVELOPE);
        const flags = (Array.isArray(o.FLAGS) ? o.FLAGS : []).map(String);
        return { uid: Number(o.UID), date: e.date || text(o.INTERNALDATE), from: e.from.join(', '), to: e.to.join(', '), subject: e.subject,
          unread: !flags.some((fl) => /^\\Seen$/i.test(fl)), ...(flags.some((fl) => /^\\Answered$/i.test(fl)) ? { answered: true } : {}), size: Number(o['RFC822.SIZE']) || undefined };
      }).sort((x, y) => y.uid - x.uid);
      return { folder, total: uids.length, emails: rows };
    }),
  },
  {
    name: 'read_message',
    description: 'One email in full: who it is from and to, the subject, the date, the text of the message, and the names of any attachments. Reading it does not mark it as read.',
    inputSchema: req({ folder: FOLDER, uid: UID }, ['uid']),
    run: async (cl, a) => cl.session(async (c) => {
      const folder = await cl.examine(c, a.folder);
      const o = await cl.fetchOne(c, a.uid, `(UID FLAGS ENVELOPE RFC822.SIZE BODY.PEEK[]<0.${MAX_FETCH}>)`);
      const e = envelope(o.ENVELOPE);
      const key = Object.keys(o).find((k) => k.startsWith('BODY['));
      const raw = Buffer.isBuffer(o[key]) ? o[key].toString('latin1') : text(o[key]);
      const parts = walkMessage(raw);
      let body = (parts.plain.join('\n\n').trim() || htmlToText(parts.html.join('\n\n'))).replace(/\r\n?/g, '\n');
      const size = Number(o['RFC822.SIZE']) || raw.length;
      const cut = body.length > MAX_TEXT;
      if (cut) body = body.slice(0, MAX_TEXT);
      const replyTo = e.reply_to.join(', ');
      return { folder, uid: a.uid, date: e.date, from: e.from.join(', '), ...(replyTo && replyTo !== e.from.join(', ') ? { reply_to: replyTo } : {}), to: e.to.join(', '), cc: e.cc.join(', ') || undefined,
        subject: e.subject, message_id: e.message_id, text: body, ...(cut ? { note: `The text was cut at ${MAX_TEXT} characters.` } : {}),
        attachments: parts.attachments, ...(size > MAX_FETCH ? { too_big: 'Only the first 5 MB of this email was read; some attachments may be missing from the list.' } : {}) };
    }),
  },
  {
    name: 'save_draft',
    description: 'Write an email and save it to the Drafts folder. NOTHING IS SENT: the owner opens it in their mail app, checks it and presses Send. To reply, give reply_to_uid (and the folder it is in): the draft is threaded under that email, addressed to its sender and titled "Re: ..." unless you say otherwise. Plain text only.',
    inputSchema: req({
      to: { type: 'array', items: { type: 'string' }, description: 'Recipients, as email addresses or "Name <address>". Optional when replying.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Optional.' },
      subject: str('Optional when replying.'),
      body: str('The email, as plain text.'),
      reply_to_uid: { type: 'integer', minimum: 1, description: 'Optional: the uid of the email this replies to.' },
      reply_to_folder: str('Optional: the folder that email is in. Default INBOX.'),
    }, ['body']),
    run: async (cl, a) => cl.session(async (c) => {
      let to = addressList(a.to, 'to'); const cc = addressList(a.cc, 'cc');
      let subject = a.subject; let inReplyTo; let references;
      if (a.reply_to_uid) {
        await cl.examine(c, a.reply_to_folder);
        const o = await cl.fetchOne(c, a.reply_to_uid, '(UID ENVELOPE BODY.PEEK[HEADER.FIELDS (REFERENCES)])');
        const e = envelope(o.ENVELOPE);
        const hk = Object.keys(o).find((k) => k.startsWith('BODY['));
        const refs = (first(parseHeaders(text(o[hk])), 'references') || '').trim();
        inReplyTo = e.message_id;
        references = [refs, e.message_id].filter(Boolean).join(' ').slice(-1900) || undefined;
        if (!to.length) to = addressList((e.reply_to.length ? e.reply_to : e.from), 'to');
        if (!subject) subject = /^re:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject || ''}`;
      }
      if (!to.length) throw new MailError('Who is this email to? Give at least one address in "to".');
      const d = await cl.draftsFolder(c);
      if (!d) throw new MailError('Could not find a Drafts folder in this mailbox. Set the folder name on the Connections page (Drafts folder).');
      const msg = buildDraft({ from: cl.from, to, cc, subject: subject || '', body: a.body, inReplyTo, references });
      const r = cl.ok(await c.command('APPEND', astring(d.raw), '(\\Draft \\Seen)', msg), 'saving the draft');
      const uid = (r.info.match(/APPENDUID\s+\d+\s+(\d+)/i) || [])[1];
      return { saved: true, folder: d.name, ...(uid ? { uid: Number(uid) } : {}), to: to.join(', '), subject: subject || '',
        note: 'Saved to your Drafts folder. Nothing has been sent: open it in your mail app, check it, and press Send there.' };
    }),
  },
];

// One JSON-RPC message in, at most one out (notifications get none).
export async function handle(msg, client) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;
  if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (msg.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) return fail(-32602, `unknown tool: ${String(msg.params?.name).slice(0, 60)}`);
    try {
      const out = await tool.run(client, msg.params?.arguments || {});
      const structured = Array.isArray(out) ? { records: out } : out;
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: structured });
    } catch (e) {
      // a refusal from the mail server is an ANSWER to relay, not a crash
      const words = e instanceof MailError ? e.message : `Something went wrong talking to your mail server: ${String(e?.message || e).slice(0, 200)}`;
      return reply({ content: [{ type: 'text', text: words }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${String(msg.method).slice(0, 60)}`);
}

if (isMain(import.meta.url)) {
  const e = process.env;
  const client = createClient({ host: e.IMAP_HOST, port: e.IMAP_PORT, security: e.IMAP_SECURITY, user: e.IMAP_USER, pass: e.IMAP_PASSWORD, from: e.IMAP_FROM, drafts: e.IMAP_DRAFTS });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const out = await handle(msg, client);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
