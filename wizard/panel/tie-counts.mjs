// tie-counts.mjs - the ONE answer to "how many members does this rock have".
//
// Why one function (2026-08-17, the handshake audit): member.html:10197-era
// code set orgx.joinedCount = st.ties.length, so a rock with two ANCHORED
// pebbles introduced itself as having "2 joined members" while its Pebbles
// tile said "2 anchored - 0 community" and the account site drew two anchored
// chips. Three surfaces, three counting rules, and every disagreement between
// them read as data corruption when it was arithmetic. This module is the
// arithmetic, once. member.html loads it as /tie-counts.js (panel-server
// strips the export at serve time), panel-server imports it directly, and the
// unit tests run it standalone.
//
// Vocabulary (the worker's, which is the authority):
//   a TIE is a directory edge { slug, tie|rel: anchored|joined, status }.
//     A tie with NO rel predates rel and is anchored (worker.js memberRel:
//     that was the only kind that existed before rel shipped). NOTE the
//     account site currently defaults the other way (minerals.js reads
//     e.rel || 'joined'); the divergence is pinned in tie-counts.test.mjs.
//   a REGISTRY ROW is the rock's seat for an anchored member
//     { slug, status: active|paused|left }. Joined members hold no row.
//
// The counts:
//   anchored - members anchored here and active: every active seat, plus every
//              live anchored tie whose seat does not exist yet (see wiring)
//   joined   - live rel:joined ties. An anchored tie NEVER counts here, and a
//              left one never does: that pair is the whole finding
//   left     - seats and ties whose status is left. Counted nowhere else
//   wiring   - the subset of anchored counted only from a tie: adoption has
//              not built its seat yet (the T6/T7 machinery is mid-flight).
//              A tie whose seat exists (any status) is the seat's to count
//
// A paused seat sits in NO bucket: it is neither active nor gone, and the
// fleet list draws it in its own right. Keep this function pure and ES5-clean
// in body: the browser runs it verbatim.
export function tieCounts(ties, registryRows) {
  var rows = (Array.isArray(registryRows) ? registryRows : []).filter(function (r) { return r && r.slug; });
  var list = (Array.isArray(ties) ? ties : []).filter(Boolean);
  var anchored = 0, joined = 0, left = 0, wiring = 0;
  var seats = {};   // slug -> true for EVERY seat, whatever its status
  rows.forEach(function (r) {
    seats[r.slug] = true;
    if (r.status === 'left') left++;
    else if (r.status !== 'paused') anchored++;
  });
  list.forEach(function (t) {
    var rel = (t.tie || t.rel) === 'joined' ? 'joined' : 'anchored';
    if (t.status === 'left') { left++; return; }
    if (rel === 'joined') { joined++; return; }
    var slug = String(t.slug || '');
    if (slug && seats[slug]) return;   // the seat already spoke for this member
    anchored++; wiring++;
  });
  return { anchored: anchored, joined: joined, left: left, wiring: wiring };
}
