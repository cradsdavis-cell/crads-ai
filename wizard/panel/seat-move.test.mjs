// seat-move.test.mjs: the "Where it lives" card on Your mineral (2026-10-14).
// A folder offers Move to a server and lists what a move down paused; a server
// offers Move to this computer; a folder a move up left behind says so.
//   node --test wizard/panel/seat-move.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { runLocalVerb } from './local-verbs.mjs';

const MEMBER = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the card is wired to the door’s two moves, by face, and never on a rock', () => {
  assert.match(MEMBER, /<div class="guidecard" id="seatMoveCard" style="display:none">/);
  const fn = MEMBER.slice(MEMBER.indexOf('function seatMoveRender(st){'), MEMBER.indexOf('function seatRow('));
  assert.match(fn, /location\.href = picker\.base \+ '\/#move-' \+ \(local \? 'up' : 'down'\) \+ '=' \+ encodeURIComponent\(state\.host\)/);
  assert.match(fn, /btn\.textContent = local \? 'Move to a server' : 'Move to this computer'/);
  assert.match(fn, /\(st\.ownership \|\| \{\}\)\.tier === 'rock'/, 'a rock is not moved to a laptop');
  assert.match(fn, /teamState && teamState\.team/, 'nor is a team\u2019s server');
  assert.match(MEMBER, /if \(st && st\.team && \$\('seatMoveCard'\)\) \$\('seatMoveCard'\)\.style\.display = 'none';/, 'even when the seat drew before the team answer');
  assert.match(fn, /!picker\.base/, 'no door, no button that dead-ends');
  assert.match(fn, /btn\.style\.display = moved \? 'none' : ''/, 'the copy a move up left behind does not offer a second move');
  assert.match(MEMBER, /Paused: needs a server/);
  assert.match(MEMBER, /seatMoveRender\(st\);\n\s*var b = st\.backup/, 'rendered with the seat');
});

test('a folder’s console state carries what a move paused and where a move up went', async () => {
  const box = tmpDir('seatmove-');
  mkdirSync(join(box, '.kernel', 'paused'), { recursive: true });
  writeFileSync(join(box, 'profile.yaml'), 'identity:\n  assistant_name: "Ana"\n');
  writeFileSync(join(box, '.kernel', 'paused', 'paused.json'), JSON.stringify({ version: 1, from: 'ana-box', paused_at: '2026-10-14T00:00:00Z', items: [{ id: 'telegram', words: 'Telegram', detail: 'your bot' }], files: [] }));
  writeFileSync(join(box, '.kernel', 'moved.json'), JSON.stringify({ to: 'ana2-box', at: '2026-10-14T01:00:00Z', commit: 'x' }));
  const lines = [];
  const code = await runLocalVerb({ path: box, name: 'Ana' }, 'member-console-state', {}, { emit: (l) => lines.push(l) });
  assert.equal(code, 0);
  const st = JSON.parse(lines[0].slice('CONSOLE_STATE '.length));
  assert.deepEqual(st.paused.items.map((i) => i.id), ['telegram']);
  assert.equal(st.paused.from, 'ana-box');
  assert.equal(st.moved.to, 'ana2-box');
});
