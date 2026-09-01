#!/usr/bin/env node
// Practice Partner setup wizard: local web UI (D33 MVP; thin wrapper since D41 phase 2).
//
// This is the hosted/VPS entry and behaves exactly as it always has: bash engine
// (wizard/aios-setup.sh with AIOS_SETUP_* env), WIZARD_KEY gate, port 7799, redacted
// last-session.log. The request pipeline itself lives in server-lib.mjs so the packaged
// desktop app (wizard/app.mjs) can run the same server on the pure-JS engine instead.
//
//   node wizard/ui/server.mjs        then open http://127.0.0.1:7799
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizardServer } from './server-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WIZARD_PORT || 7799);

const server = createWizardServer({
  engine: 'bash',
  port: PORT,
  host: '127.0.0.1',
  key: process.env.WIZARD_KEY || '',
  htmlPath: join(HERE, 'index.html'),
  log: join(HERE, 'last-session.log'),
});
server.on('listening', () =>
  console.log(`Practice Partner setup wizard: http://127.0.0.1:${PORT}  (local only; Ctrl-C to quit)`));
