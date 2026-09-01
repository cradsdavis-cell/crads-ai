// inventory.mjs — ONE list of every mineral a person has (spec:
// docs/superpowers/specs/2026-08-13-mineral-inventory.md, ratified 2026-08-13).
//
// Before this module the door rendered THREE lists derived from TWO truths and
// never joined them: /identities (SSH Host blocks on this machine),
// /account/minerals (grants the signed-in account holds) and /account/devices
// (registered boxes it could ask to admit this machine). Nothing cross-
// referenced them, so the screen could not answer any of the three questions it
// exists to answer: what is a rock, what is a pebble, what is on my account but
// not on this computer. Worse, /account/devices subtracted nothing, so a mineral
// already open on this machine was offered again as something to connect to.
//
// The join key is trivial and always was: `slug`. A member alias is
// `<slug>-box`, a rock alias is `<org>-rock`, and a mineral's host is
// `<slug>.crads-ai.com`, so listPanelTargets' `org` field IS the slug (it is
// even commented as such at member-connect.mjs:369, where this exact merge
// already ships for the /my-orgs picker).
//
// DELIBERATELY PURE. No fs, no fetch, no SSH. The two callers (door-server,
// panel-server) do the I/O and hand the results in, so the rules here test
// without a network, without an ~/.ssh, and without a directory worker. That
// matters more than usual: ruling 4 makes offline a first-class state, and a
// module that could only be exercised online would be the wrong shape for it.

/** Tier inferred from a wizard-installed alias. The default when the account
 *  layer has not answered (offline, signed out, worker down) — honest, because
 *  it is the same guess the door has always shown, and never blank. */
export function tierFromAlias(alias) {
  return /-rock$/.test(String(alias || '')) ? 'rock' : 'pebble';
}

/** The slug a mineral host names: `aster.crads-ai.com` -> `aster`.
 *  A host whose first label already carries the `-box` suffix (some older
 *  registrations) resolves to the same slug the alias does, so the join holds
 *  from both directions. */
export function slugOfHost(host) {
  return String(host || '').split('.')[0].replace(/-(box|rock)$/, '').toLowerCase();
}

/** The slug a local target names. `org` is the alias prefix; normalise it the
 *  same way as slugOfHost so the two sides of the join cannot disagree on case
 *  or on a stray suffix. */
export function slugOfTarget(t) {
  return String((t && t.org) || '').replace(/-(box|rock)$/, '').toLowerCase();
}

/**
 * Collapse listPanelTargets output to ONE row per mineral.
 *
 * A MINERAL IS A MINERAL (ruling 7, inheriting ruling 1 of the upgraded-pebble
 * spec). listPanelTargets emits a SECOND rock-kind row under the same alias for
 * a promoted box (ssh-bridge.mjs:187), because a promoted rock keeps its `-box`
 * alias. That overlay is a leftover of D44's two-editions model, which the
 * 2026-08-09 ruling reversed: there is one shell, and the edition is stamped
 * from the face probe. So the door showing two cards for one box was the screen
 * asserting a model the product had already retired.
 *
 * Grouped by ALIAS, not slug: the alias is what SSH dials and what /go/* has to
 * carry, and two genuinely different minerals can never share one. A group
 * containing any rock-kind row IS a rock — the overlay only ever fires when the
 * box itself probed as one, so that is the box's own answer, not the suffix's
 * guess.
 */
export function collapseLocal(targets = []) {
  const byAlias = new Map();
  for (const t of targets) {
    if (!t || !t.host) continue;
    const alias = String(t.host);
    const prev = byAlias.get(alias);
    if (!prev) {
      // `sure`: a rock-kind row is never a guess — it is either a `-rock`
      // alias (installed as one) or the promoted overlay (the box's own probe
      // answer). A member-only group is ONLY the `-box` suffix talking, and a
      // rock promoted or provisioned recently still wears that suffix — the
      // exact rows Harriet's door painted "Pebble" on 2026-08-18.
      byAlias.set(alias, { alias, slug: slugOfTarget(t), tier: t.kind === 'rock' ? 'rock' : 'pebble', sure: t.kind === 'rock', promoted: !!t.promoted });
      continue;
    }
    // the box answered "rock" on one of its rows: that wins over the alias guess
    if (t.kind === 'rock') { prev.tier = 'rock'; prev.sure = true; prev.promoted = prev.promoted || !!t.promoted; }
  }
  return [...byAlias.values()];
}

/** Who holds a mineral, in words a reader can act on.
 *  `held_by` from /my-minerals is already plain ('you' | '<org>' | 'someone
 *  else'), so this only classifies it — an org-held pebble must never render as
 *  "shared with you" (ruling 6): that is false for a member's own working
 *  assistant, and false in exactly the anchored shape cohort one ships in. */
export function heldOf(mineral) {
  const h = String((mineral && mineral.held_by) || '').trim();
  if (!h) return { held: 'unknown', holder: '' };
  if (h === 'you') return { held: 'you', holder: '' };
  if (h === 'someone else') return { held: 'other', holder: '' };
  return { held: 'org', holder: h };
}

/**
 * The merge. Local rows always survive; account rows add what this machine
 * cannot open; nothing is listed twice.
 *
 * @param {object} p
 *   local        collapsed local rows (collapseLocal output)
 *   account      /my-minerals rows, or null when the account layer has NOT
 *                answered. NULL AND [] MEAN DIFFERENT THINGS and the difference
 *                is load-bearing: null is "we do not know yet" (offline, signed
 *                out, worker down) and must not flag anything as missing from
 *                the account; [] is "we asked and this account holds nothing",
 *                which legitimately flags every local row.
 *   boxes        /my-boxes rows (minerals whose box has registered SSH facts),
 *                or [] — the only rows this machine can actually ASK to admit it
 *   email        the signed-in account, for the flag's wording
 *   probed       aliases whose face probe has COMPLETED this session, whatever
 *                it answered (tier-honesty, 2026-08-19). A completed probe
 *                settles the guess: either it registered a rock face (and the
 *                local rows already say so) or the guess stands as the honest
 *                fail-open answer. Either way the door can stop saying
 *                "Checking…" for that row.
 */
export function mergeInventory({ local = [], account = null, boxes = [], email = '', probed = [] } = {}) {
  const accountLoaded = Array.isArray(account);
  const accBySlug = new Map();
  for (const m of (account || [])) {
    const s = slugOfHost(m.host || m.org || m.slug);
    if (s) accBySlug.set(s, m);
  }
  const boxBySlug = new Map();
  for (const b of boxes || []) {
    const s = slugOfHost(b.host);
    if (s) boxBySlug.set(s, b);
  }

  const rows = [];
  const claimed = new Set();

  // 1. everything this machine can open, whether or not the account knows it.
  //    These render FIRST and WITHOUT WAITING (ruling 4): they come off disk.
  for (const l of local) {
    const m = accBySlug.get(l.slug) || null;
    if (m) claimed.add(l.slug);
    const { held, holder } = heldOf(m);
    rows.push({
      slug: l.slug,
      alias: l.alias,
      label: (m && String(m.label || '').trim()) || l.slug,
      // the ACCOUNT's tier wins when we have it (the directory holds the
      // mineral record); the alias/probe answer is the offline fallback
      tier: (m && (m.tier === 'rock' || m.tier === 'pebble')) ? m.tier : l.tier,
      // tierKnown — did anyone actually ANSWER, or is the tier above only the
      // alias suffix's guess? Known when the account answered, when the row
      // itself is sure (a -rock alias, or the box's own probe answer), or when
      // a probe has completed for this alias and the fail-open guess stands.
      // The door renders an unsure row as "Checking…" and its click still
      // routes by the guess — display honesty, not a new gate (Harriet,
      // 2026-08-18: a cold cache + an unanswered account painted her rock
      // "Pebble" and opened it as one).
      tierKnown: !!(m && (m.tier === 'rock' || m.tier === 'pebble')) || !!l.sure || probed.includes(l.alias),
      onDevice: true,
      enrollable: false,
      held, holder,
      // RULING 5. Listed and flagged, never hidden: the key is what opens the
      // box and stays sovereign. But Sam signed in with an unrelated account on
      // 2026-08-10 and read the whole list as that account's holdings, so a row
      // the signed-in account has no grant on must SAY so, and name the account
      // it was measured against. Only meaningful once the account layer has
      // actually answered — see the null-vs-[] note above.
      flagged: accountLoaded && !m,
      flagAccount: accountLoaded && !m ? String(email || '') : '',
    });
  }

  // 2. minerals the account holds that this machine cannot open. FINDING 8 is a
  //    one-line consequence of this subtraction, which nothing did before:
  //    listEnrollable returned every registered box and the door offered to
  //    connect to minerals that were already connected.
  for (const m of (account || [])) {
    const s = slugOfHost(m.host || m.org || m.slug);
    if (!s || claimed.has(s) || local.some((l) => l.slug === s)) continue;
    claimed.add(s);
    const { held, holder } = heldOf(m);
    rows.push({
      slug: s,
      alias: '',
      // the name the DIRECTORY issued. The enrol ask must send this, not the
      // slug and not a local alias (there is none yet): the two naming schemes
      // are exactly what not-let-in.test.mjs pins member.html against comparing
      // by equality.
      host: String(m.host || ''),
      label: String(m.label || '').trim() || s,
      tier: (m.tier === 'rock' || m.tier === 'pebble') ? m.tier : 'pebble',
      // the account listed it, so the account has answered for it
      tierKnown: true,
      onDevice: false,
      // only offer the ask when there is a registered box to ask. A grant with
      // no registration has nothing on the other end of the request, and an
      // offered button that cannot work is the shape of finding 9.
      enrollable: boxBySlug.has(s),
      held, holder,
      flagged: false,
      flagAccount: '',
    });
  }

  return rows;
}

/**
 * Display order. On-device first (those are the ones a click can open right
 * now), last-used at the top of them, then off-device.
 *
 * `last` is this machine's localStorage record. WITHOUT ONE, NOTHING IS
 * ANCHORED: the old door drew the primary-pick accent rail on identities[0],
 * which is SSH-config parse order wearing the clothes of a recommendation.
 * A tie falls back to label, so the order is at least stable and explicable.
 */
export function orderInventory(rows = [], last = '') {
  const rank = (r) => {
    if (r.onDevice && last && r.alias === last) return 0;
    if (r.onDevice) return 1;
    return 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || String(a.label).localeCompare(String(b.label)));
}

/** Does any row deserve the anchor rail? Only a real last-used record earns it. */
export function anchorAlias(rows = [], last = '') {
  return (last && rows.some((r) => r.onDevice && r.alias === last)) ? last : '';
}
