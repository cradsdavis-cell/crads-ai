#!/usr/bin/env node
// serve-voice.mjs — the voice "call" surface for ONE box (reusable per client).
//
// A hands-free spoken conversation with the client's own brain. The browser does
// STT + TTS (Web Speech API, zero infra); this server is the thin bridge to the
// kernel: a spoken turn is enqueued as a normal `message` job (source:'voice'), the
// kernel runs it through Claude Code exactly like a Telegram turn, and the reply is
// read back and spoken. Same single-writer (D9) + default-deny-outbound (D4)
// guarantees as every other interface — voice is just another edge, not a bypass.
//
//   node serve-voice.mjs <boxDir> [port]
//
// Bind host mirrors serve-cockpit: 127.0.0.1 by default (host-native, reached via the
// VS Code tunnel / subdomain), VOICE_HOST=0.0.0.0 in a container (the container is then
// the isolation boundary and only the explicit -p mapping exposes it).
//
// Optional premium voice (else the browser speaks with its built-in TTS):
//   VOICE_TTS_API_KEY   — enables server-side TTS (audio returned from /api/tts)
//   VOICE_TTS_URL       — default https://api.openai.com/v1/audio/speech (OpenAI-compatible)
//   VOICE_TTS_MODEL     — default tts-1
//   VOICE_TTS_VOICE     — default alloy
import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueue, kpaths, ensureDirs } from '../kernel/lib/queue.mjs';

const box = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
// Default 7782: on managed boxes 7780=cockpit and 7781=code-server are already taken.
const port = Number(process.argv[3] || process.env.VOICE_PORT || 7782);
const host = process.env.VOICE_HOST || '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const pageFile = path.join(here, 'voice.html');

const TTS_KEY = process.env.VOICE_TTS_API_KEY || '';
const TTS_URL = process.env.VOICE_TTS_URL || 'https://api.openai.com/v1/audio/speech';
const TTS_MODEL = process.env.VOICE_TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.VOICE_TTS_VOICE || 'alloy';

const log = (...m) => console.log(`[voice ${new Date().toISOString()}]`, ...m);

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1 << 20) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// POST /api/turn {text} -> enqueue a voice message job; return its outbox key.
async function handleTurn(req, res) {
  const body = await readBody(req).catch(() => null);
  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json(res, 400, { error: 'empty' });
  const { name } = await enqueue(box, { skill: 'message', args: { text }, reply_to: 'voice', source: 'voice' });
  log(`turn -> ${name}: ${text.slice(0, 60)}`);
  json(res, 200, { name });
}

// GET /api/reply?name=... -> the kernel writes the reply to .kernel/voice-outbox/<name>
// once the turn completes. Poll it; hand it back once (delete on read).
async function handleReply(req, res, url) {
  const name = url.searchParams.get('name') || '';
  if (!/^[\w.\-]+\.json$/.test(name)) return json(res, 400, { error: 'bad-name' });
  const p = kpaths(box);
  const f = path.join(p.base, 'voice-outbox', name);
  if (!existsSync(f)) return json(res, 200, { pending: true });
  try {
    const rec = JSON.parse(await readFile(f, 'utf8'));
    await unlink(f).catch(() => {});
    json(res, 200, { pending: false, text: rec.text || '' });
  } catch { json(res, 200, { pending: true }); }
}

// POST /api/tts {text} -> premium voice if a key is configured, else 204 (browser speaks).
async function handleTts(req, res) {
  if (!TTS_KEY) { res.writeHead(204); return res.end(); }
  const body = await readBody(req).catch(() => null);
  const text = body && typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
  if (!text) return json(res, 400, { error: 'empty' });
  try {
    const r = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TTS_KEY}` },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3' }),
    });
    if (!r.ok) { log('tts upstream', r.status); res.writeHead(204); return res.end(); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) { log('tts', String(e).slice(0, 120)); res.writeHead(204); res.end(); }
}

await ensureDirs(box);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(pageFile));
    }
    if (req.method === 'POST' && url.pathname === '/api/turn') return handleTurn(req, res);
    if (req.method === 'GET' && url.pathname === '/api/reply') return handleReply(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/tts') return handleTts(req, res);
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { serverTts: !!TTS_KEY });
    res.writeHead(404); res.end('not found');
  } catch (e) { log('req', String(e).slice(0, 150)); try { json(res, 500, { error: 'server' }); } catch {} }
}).listen(port, host, () => log(`voice: http://localhost:${port}  (box ${path.basename(box)}, bind ${host}, tts ${TTS_KEY ? 'server' : 'browser'})`));
