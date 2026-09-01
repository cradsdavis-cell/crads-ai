// The 2026-08-09 lag audit: the map's probes ride ONE exec (topology-state /
// org-topology-state), and dashboard-data serves a young data.json without a
// rebuild unless fresh:1 forces the walk. These pins keep both from silently
// regressing into per-probe SSH round-trips or an uncacheable dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS, VERBS } from './panel-server.mjs';

test('topology-state batches console + devices + support into one command', () => {
  const cmd = MEMBER_VERBS['topology-state'].build().command;
  assert.ok(cmd.includes('CONSOLE_STATE'), 'carries the console-state leg');
  assert.ok(cmd.includes('__DEVICES__'), 'devices marker present');
  assert.ok(cmd.includes('__SUPPORT__'), 'support marker present');
  assert.ok(cmd.indexOf('__DEVICES__') < cmd.indexOf('__SUPPORT__'), 'markers in split order');
  assert.ok(cmd.includes(MEMBER_VERBS['devices-list'].build().command), 'devices leg is the real verb, not a copy');
  assert.ok(cmd.includes(MEMBER_VERBS['support-status'].build().command), 'support leg is the real verb, not a copy');
  assert.ok(!MEMBER_VERBS['topology-state'].mutating, 'read-only');
});

test('org-topology-state batches the four rock-map probes, adminOnly like rock-state', () => {
  const cmd = VERBS['org-topology-state'].build().command;
  for (const m of ['__DEVICES__', '__SUPPORT__', '__STALL__', '__ROCKSTATE__']) {
    assert.ok(cmd.includes(m), m + ' marker present');
  }
  assert.ok(cmd.indexOf('__STALL__') < cmd.indexOf('__ROCKSTATE__'), 'markers in split order');
  assert.ok(cmd.includes(VERBS['stall-board'].build().command), 'stall leg is the real verb');
  assert.equal(VERBS['org-topology-state'].adminOnly, true, 'rock-state rides inside, so adminOnly must too');
});

test('dashboard-data gates the rebuild behind a 45s freshness check; fresh:1 bypasses it', () => {
  const cached = MEMBER_VERBS['dashboard-data'].build({}).command;
  assert.ok(cached.includes('stat -c %Y'), 'default build checks data.json age');
  assert.ok(cached.includes('__CACHED__'), 'cache hit is declared to the client');
  assert.ok(cached.includes('box-cockpit.mjs'), 'stale path still rebuilds');
  const fresh = MEMBER_VERBS['dashboard-data'].build({ fresh: 1 }).command;
  assert.ok(!fresh.includes('stat -c %Y'), 'fresh:1 never consults the cache gate');
  assert.ok(fresh.includes('box-cockpit.mjs'), 'fresh:1 always rebuilds');
  // both shapes keep serving data.json + layout.json between the same markers
  for (const c of [cached, fresh]) {
    assert.ok(c.includes('__BUILD__') && c.includes('__DATA__') && c.includes('__LAYOUT__'), 'marker protocol unchanged');
  }
});
