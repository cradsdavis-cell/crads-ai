#!/usr/bin/env node
// serve-cockpit.mjs — tiny static server for ONE box's cockpit (reusable per pebble). Serves
// <boxDir>/cockpit/ (index.html + data.json) on a port + regenerates data.json on a timer so the
// brain graph grows live during onboarding. No deps. The VS Code tunnel forwards the port, so the
// pebble opens it in their browser.
//
//   node serve-cockpit.mjs <boxDir> [port]
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const box = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 7780);
// Bind host: default 127.0.0.1 (host-native — never network-exposed). In a container set
// COCKPIT_HOST=0.0.0.0 so `docker -p` can forward it — there the container is the isolation boundary.
const host = process.env.COCKPIT_HOST || '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const cockpitDir = path.join(box, 'cockpit');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const regen = () => { try { execFileSync('node', [path.join(here, 'box-cockpit.mjs'), box], { stdio: 'ignore' }); } catch {} };
regen();
setInterval(regen, 4000);   // live growth during the interview

createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // index.html ships from the engine (single source); everything else from the box's cockpit dir.
  const file = rel === '/index.html' ? path.join(here, 'box-cockpit.html') : path.join(cockpitDir, rel);
  if (!existsSync(file) || !path.resolve(file).startsWith(path.resolve(rel === '/index.html' ? here : cockpitDir))) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, host, () => console.log(`cockpit: http://localhost:${port}  (box ${path.basename(box)}, bind ${host})`));   // default localhost-only; container sets COCKPIT_HOST=0.0.0.0 (reachable only via the explicit -p mapping).
