// access.mjs · E6.4: the ACCESS view over one org's plane, pure. Ported from
// the console's reaches() (the sandbox is the reference; divergence here is a
// bug here). Answers, for a normalized row: what can the anchor org, Crads AI,
// and the member actually do to this box, with the WHY on every closed arrow.
// States: 'open' | 'stopped' | 'temp' (granted, revocable).
const live = (r) => r.status === 'active';

export function reachesFor(row = {}, { anchorSlug = '' } = {}) {
  const out = [];
  const owned = row.owner !== 'member' && (row.owner === anchorSlug || row.owner === 'org');
  const stoppedWhy = live(row) ? null : `this box is ${row.status}`;
  const hp = row.delivery_pause === 'true';
  const consent = owned ? true : row.infra_push_consent !== 'false';

  const org = { name: anchorSlug, sub: [owned ? 'owner' : '', 'anchor'].filter(Boolean).join(' + ') + ' rock', arrows: [] };
  org.arrows.push({ label: 'sends content down', state: live(row) && !hp ? 'open' : 'stopped',
    why: stoppedWhy || (hp ? 'the anchor paused delivery' : null) });
  org.arrows.push({ label: 'installs skills + cadence', state: live(row) && !hp && consent ? 'open' : 'stopped',
    why: stoppedWhy || (hp ? 'the anchor paused delivery' : !consent ? 'installs refused (consent, D60 O6)' : null) });
  org.arrows.push({ label: 'reads this brain',
    state: owned ? 'open' : row.read_consent === 'true' ? 'temp' : 'stopped',
    why: owned ? 'it owns it' : row.read_consent === 'true' ? 'granted, revocable' : 'not its repo' });
  org.arrows.push({ label: 'can shut the door', state: owned ? 'open' : 'stopped',
    why: owned ? 'ownership: lifecycle is the owner’s' : 'anchor, not owner: it executes, it cannot revoke' });
  org.arrows.push({ label: 'receives heartbeats', state: 'open', why: 'liveness + version, never content' });
  org.arrows.push({ label: 'holds the registry row', state: 'open', why: 'it anchors this box' });
  if (row.managed_by === 'org') {
    org.arrows.push({ label: 'operates the machine', state: 'open', why: 'the anchor’s metal' });
    org.arrows.push({ label: 'sees host telemetry', state: 'open', why: 'it operates the VM' });
  }
  out.push(org);

  const plat = { name: 'Crads AI', sub: 'the platform', arrows: [] };
  plat.arrows.push({ label: 'ships machine updates', state: 'open', why: 'the machinery layer, every box' });
  if (row.managed_by === 'crads-ai') {
    plat.arrows.push({ label: 'operates the machine', state: 'open', why: 'provision, update, restart. Ops only' });
    plat.arrows.push({ label: 'sees host telemetry', state: 'open', why: 'it operates the VM' });
  } else {
    plat.arrows.push({ label: 'sees host telemetry', state: 'stopped', why: 'not the operator here' });
  }
  plat.arrows.push({ label: 'can shut the door', state: 'stopped', why: 'operator, not owner: it executes the owner’s order' });
  plat.arrows.push({ label: 'reads this brain', state: 'stopped', why: 'never: operating is ops only' });
  out.push(plat);

  const person = { name: 'the member', sub: 'the device key', arrows: [] };
  person.arrows.push({ label: 'opens it', state: 'open', why: 'their own device key' });
  person.arrows.push({ label: 'can shut the door', state: row.owner === 'member' ? 'open' : 'stopped',
    why: row.owner === 'member' ? 'ownership: shutdown is theirs to order' : `${row.owner} owns it; leaving is theirs, shutdown is not` });
  if (row.managed_by === 'member') person.arrows.push({ label: 'operates the machine', state: 'open', why: 'their own metal' });
  out.push(person);
  return out;
}
