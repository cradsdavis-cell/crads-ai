// queue.mjs — durable, file-backed job queue (decisions D9).
// Jobs are JSON files under <state>/.kernel/queue, named by ISO-timestamp so a
// lexical sort == chronological order. Enqueue is atomic (write-temp + rename).
// Drained jobs move to /done; failures move to /failed. Survives restarts.
//
// NOTE on Date: this is RUNTIME code on the host, not a Workflow script — the
// Date restriction that applies to workflow scripts does NOT apply here.
import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { nowISO } from '../../lib/clock.mjs';   // injectable clock (spec §0.5) — virtual time in test mode

const KDIR = '.kernel';

export function kpaths(stateDir) {
  const base = path.join(stateDir, KDIR);
  return {
    base,
    queue: path.join(base, 'queue'),
    done: path.join(base, 'done'),
    failed: path.join(base, 'failed'),
    lock: path.join(base, 'lock'),
    humanLock: path.join(base, 'human-lock'),
  };
}

export async function ensureDirs(stateDir) {
  const p = kpaths(stateDir);
  for (const d of [p.base, p.queue, p.done, p.failed]) await mkdir(d, { recursive: true });
  return p;
}

export async function enqueue(stateDir, job) {
  const p = await ensureDirs(stateDir);
  const id = job.id || randomUUID();
  const created = job.created || nowISO(stateDir);   // virtual time when the harness injects a clock
  const rec = { id, created, type: 'skill', ...job };
  const name = `${created.replace(/[:.]/g, '-')}__${id}.json`;
  const tmp = path.join(p.queue, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(rec, null, 2));
  await rename(tmp, path.join(p.queue, name)); // atomic publish
  return { id, name };
}

export async function listQueued(stateDir) {
  const p = kpaths(stateDir);
  let files;
  try { files = (await readdir(p.queue)).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  files.sort(); // timestamp-prefixed => chronological (FIFO)
  const jobs = [];
  for (const f of files) {
    const rec = JSON.parse(await readFile(path.join(p.queue, f), 'utf8'));
    jobs.push({ ...rec, file: path.join(p.queue, f), name: f });
  }
  return jobs;
}
