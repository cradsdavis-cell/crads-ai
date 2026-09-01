#!/usr/bin/env node
// enqueue.mjs — submit a job to a client instance's queue.
// Used by the interface adapters (Telegram / cron / dashboard) and for tests.
// Interfaces NEVER write the working tree directly — they enqueue; the kernel
// serialises (decisions D9).
//
//   node enqueue.mjs <state-dir> <skill> [json-args] [--source=cron|telegram|dashboard|cli]
import path from 'node:path';
import { enqueue } from './lib/queue.mjs';

const argv = process.argv.slice(2);
const stateDir = path.resolve(argv[0] || process.env.STATE_DIR || '.');
const skill = argv[1];
if (!skill) {
  console.error('usage: enqueue.mjs <state-dir> <skill> [json-args] [--source=x]');
  process.exit(1);
}
const jsonArgs = argv[2] && !argv[2].startsWith('--') ? JSON.parse(argv[2]) : {};
const source = (argv.find((a) => a.startsWith('--source=')) || '--source=cli').split('=')[1];
const replyTo = (argv.find((a) => a.startsWith('--reply-to=')) || '').split('=')[1];

const { id } = await enqueue(stateDir, { skill, args: jsonArgs, source, ...(replyTo ? { reply_to: replyTo } : {}) });
console.log(`enqueued /${skill} -> ${id}`);
