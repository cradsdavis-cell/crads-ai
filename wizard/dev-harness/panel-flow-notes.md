# Org panel: flow-walk notes (motion + transition evidence)

Companion to the panel screenshot set produced by `panel-shots.mjs`. Screenshots are
stills; this file documents what moves between them, with file/line references into
`wizard/panel/panel.html` (line numbers as of iteration 5). Judges may treat every claim
here as verifiable against the referenced source line.

Design-language budget (docs/superpowers/ui-overhaul/design-language.md § Shape, depth,
motion): 120ms ease-out hovers · 180ms panel/nav transitions · 240ms modals ·
`prefers-reduced-motion: reduce` kills all non-essential animation. Every entry below
stays inside that budget; there are no other animations in the file.

## 1. Presence ring breathe (signature element)

- What: the header presence dot's outer ring scales .55 → 1 and fades .45 → .12,
  breathing while the rock's box is connected. Core dot is static.
- Where: `.dot.ok::before` animation (panel.html:71), keyframes `breathe` (line 74).
- Duration/easing: 3s ease-in-out, infinite. Error and checking states do NOT animate
  (static red / faint ring, lines 67-73): motion itself carries meaning; only a live
  connection breathes.
- Reduced motion: animation removed, ring frozen at a quiet mid-state (line 464).
- Evidence stills: every connected shot (e.g. `panel-light`) vs `panel-error-*`
  (static red dot, "Not connected").

## 2. Skeleton shimmer (fleet loading) — amplitude raised + rig made deterministic (iter 3)

- What: while the registry index + heartbeats are in flight, six placeholder cards show
  gray lines with a lighter highlight band sweeping left → right across each line.
- Where: line base one step below the card surface (`.skel .ln`, line 222: 60% --line
  into --card-2); sweep gradient through `--shimmer-hi` (line 227), keyframes `shimmer`
  (line 228); skeletons injected by `renderFleetSkeletons()` (line 1024), shown on
  connect before first data (line 1081).
- Amplitude (iteration-3 fix): the highlight is now genuinely LIGHTER than the line in
  both themes — light `rgba(255,255,255,.92)` (line 220), dark 18% --ink (line 459).
  The previous dark "highlight" was mixed from --card, which is darker than the line it
  swept: invisible by construction. Measured on the rendered stills, the sweep peak now
  sits 23 grey-levels above the line base in light and 34 in dark.
- Duration/easing: 1.6s ease, infinite; the ::after layer translates -100% → +100%.
- Reduced motion: shimmer animation removed, static placeholder lines remain (line 465).
- Evidence stills (deterministic since iteration 3): the rig freezes the animation at
  two fixed negative delays (`freezeShimmer(-0.35)` / `freezeShimmer(-1.15)` in
  panel-shots.mjs), so `panel-loading-*` captures the highlight near the line END and
  `panel-skeleton-mid-*` around the line CENTER — measured peak positions ~90px apart
  on the same 200px line, identical on every run. The live app still animates normally;
  the freeze is rig-side CSS injection only.
- State honesty note (iteration-2 fix): `renderFleet()` refuses to paint until the
  registry has answered once (`state.indexLoaded` guard, line 1160), so the fast
  member-list return can no longer flash a false "No members yet" over the skeletons.

## 3. Nav section swaps

- What: sidebar nav switches sections by toggling `display` (`activateSec`, line 932).
  Deliberately INSTANT, no cross-fade: perceived speed beats decoration for in-app tab
  switches; the incoming section's data loads live while the frame is already painted.
- Hover/active affordance on nav buttons: background/color transition 120ms ease
  (line 46); active item gains card background + shadow-1.

## 4. Help modal entrance (the one modal)

- What: opening the Claude Code connect guide fades the veil in and raises the box
  (translateY 10px → 0, scale .985 → 1). Close is instant (a dismissal should never
  make the user wait).
- Where: `.modal.open` / `.modal.open .mbox` animations (panel.html:349-353).
- Duration/easing: 240ms ease-out, per the design-language modal budget.
- Focus contract (iteration 2): `openHelp()` records the opener and moves focus to the
  close button; `closeHelp()` returns it (lines 1001-1011). Esc and veil-click both close.
- Reduced motion: both entrance animations removed (line 466).
- Evidence stills: `panel-help-*` (settled state), `panel-focus-modalclose-*`
  (double-ring focus token on the close button, keyboard-opened).

## 5. Focus grammar: ONE double-ring language, inputs AND checkboxes (iter 4)

- What: focusing any input/select/textarea shows BOTH signals at once: the border
  flips to the accent AND a double ring draws around the field — a gap ring in the
  CARD color plus an accent ring outside it. Iteration 4 extends the SAME grammar to
  checkboxes (Skills pick-rows, ack boxes): rounded card-gap double ring, so the panel
  no longer speaks two focus languages (checkboxes previously read as a flush accent
  square hugging the native box).
- Where: `:focus-visible` rule (line 26), the plain `:focus` companion (line 245),
  checkbox grammar (lines 247-251: `border-radius:4px` + a 3px card gap / 2px accent
  ring — one extra px of gap so the ring visibly detaches from the 13px native box).
- Why the card-colored gap: the shared `--focus` token gaps with --paper; on a white
  card that gap ring is invisible (iteration-2 finding). Gapping with `var(--card)`
  separates the ring on the surface the control actually sits on.
- No animation: rings appear/disappear instantly with focus; nothing to reduce.
- Evidence stills: `panel-focus-input-*` (accent border + card-gapped double ring),
  `panel-skills-focus-*` (checkbox wearing the same rounded double ring, both themes).

## 6. Add-member steps board + in-flight button (typed progress, not a spinner)

- What: pressing "Add member" renders a five-step board (`mkSteps`, line 1376). The
  running step shows an inline "…" marker and a minute counter that ticks every 20s;
  finished steps flip to "✓"; a failure freezes the failing step at "✗" and hands off
  to the plain-words error card. No animation: state swaps only.
- In-flight button (iteration 4): while the run is live the button reads "Adding…"
  and carries `.busy` — neutral card-2 fill, soft-2 text, subtle accent border
  (lines 1516-1521; restored to "Add member" on completion, lines 1528-1531). This
  replaces the washed-accent disabled look that measured 2.28:1 light / 1.52:1 dark.
- Disabled policy behind it (iteration 4, lines 88-102): ALL disabled buttons are quiet
  neutrals — card-2 fill, soft-2 text (measured 6.0:1 light / 7.0:1 dark on card-2),
  line border, no accent, no shadow, opacity 1. Only `.busy` may carry an accent
  border, so "working" and "unavailable" are visually distinct states.
- Unarmed destructive exception (iteration 5, line 100): UNARMED Danger buttons were
  previously IDENTICAL to disabled. They keep the neutral fill but earn a low-opacity
  destructive-hue border (35% --bad into --line) and bad-tinted text (60% --bad into
  --ink) — measured 7.59:1 light / 6.80:1 dark on card-2 — so "consequential once
  armed" reads differently from "unavailable" while staying quiet until armed.
- Where: `.steps` styles from line 264; running marker `.steps .running .dot::after`
  (line 273). Iteration 2 fixed this marker fully resetting the global `.dot::after`
  circle (it previously escaped to the document corner; caught by the mid-step shot).
- Evidence stills: `panel-invite-midstep-*` (step 1 running, "Adding…" button with
  accent-edged neutral fill) vs `panel-invite-*` (all five ✓ + the green-edged "send
  their invite" box, button restored); `panel-danger-*` (unarmed teardown button:
  quiet neutral fill, destructive-tinted border + text).

## 7. Hover / active transforms

No scale/translate transforms anywhere: hover feedback is border/color/background only,
all 120ms ease, all listed in the reduced-motion kill list (lines 467-468):

- `.act` buttons: border-color + background, 120ms (line 81).
- `.mini` buttons (table + fleet card actions): border-color, 120ms (line 104).
- `.fleet-card`: border-color, 120ms (line 171).
- `details.secfold>summary` (Housekeeping fold rows): background, 120ms (line 209).
- Sidebar nav buttons: background/color, 120ms (line 46).
- Quiet disclosure links (iteration 3: `details.info>summary`, `details.guide-steps>
  summary` restyled --soft-2): hover = underline + ink, no transition, no accent.

## 8. Actions triage: conditional rendering, no motion

- The "Needs your decision" zone (join requests + staged devices) renders accent-edged
  cards only when a queue holds items; both empty collapses the zone to one quiet
  dashed row (`updateAttention`, line 1611; counters fed at lines 1639 + 1688).
  Recent device activity collapses the same way when empty.
- These are display toggles at data-arrival time, not animations: content never shifts
  under the pointer after first paint of a state.
- Evidence stills: `panel-actions-*` (waiting: accent card + count chip) vs
  `panel-actions-empty-*` (two quiet rows, Housekeeping folds).

## 9. Fleet stat strip: data-driven triage promotion (iter 4)

- What: the AT RISK and WATCH stats promote themselves ONLY when nonzero — `.hot`
  adds a tinted chip fill, tinted border, tinted label and a heavier numeral, so
  triage never rides on numeral color alone. At zero they stay quiet (ink numeral,
  no tint), so a healthy fleet reads calm.
- Where: `.sumrow` styles + promotion rules (lines 142-154, dark sweep 452-455);
  `.hot` is attached by `renderFleet()` only when the count is > 0 (lines 1182-1186).
- No animation: the chip is part of the data render, nothing transitions.
- Evidence stills: `panel-*` (fixture has 1 at-risk + 1 watch: both chips tinted;
  MEMBERS / HEALTHY / INVITED counts stay quiet).

## 10. Fleet grid orphan control: structural CSS, no JS pass (iter 4)

- What: the 3-up member grid never strands a lone card — a remainder of 1 reflows the
  last FOUR cards as 2 + 2 (7 → 3+2+2), a remainder of 2 widens the last two (5 → 3+2),
  a single card sits at half width.
- Where: `:first-pebble:nth-last-pebble(3n+r)` count-reading selectors, lines 154-169.
  Iteration 4 moved this out of `renderFleet()` (which added a `.wide` class after
  building cards) into the stylesheet: the layout rule now applies on the same frame
  the cards enter the DOM and cannot be skipped by any render path.
- Verified rendered at widths 1-8 cards in both themes (probe: 4 → 2+2, 5 → 3+2,
  7 → 3+2+2, 8 → 3+3+2).
- Evidence stills: `panel-*` (7 fixture members render 3+2+2, no dead column).

## 11. Governance: auto-growing level descriptions + sub-grouped Vocabulary (iter 3/4)

- What: membership-level descriptions are wrapping textareas that auto-grow to show
  their full text at rest and while typing — policy content is never clipped. The form
  renders as three labeled tiers whose cards flow in balanced CSS columns. Iteration 4
  sub-groups the Vocabulary card's concerns (Areas / Experts / Membership levels) under
  hairline eyebrow dividers (`.gsub`, lines 328-333; markers in GOV_SCHEMA; presentation
  only — field keys, ids and the save path untouched). Iteration 5 finishes the label
  de-duplication iteration 4 only started: the iter-4 suppression fired only when a
  field's `sub` equalled its OWN label (Membership levels), so the list fields on the
  next line still rendered "AREAS" / "EXPERTS" verbatim under their eyebrows. Now the
  eyebrow names the group and every field label is descriptive ("Your word for areas" /
  "The areas themselves") — zero verbatim eyebrow/label repeats, DOM-verified.
- Where: `textarea.tdesc` sizing (line 343, CSS `field-sizing:content`), JS belt
  `autosizeTierDesc()` (line 2022) run on render/add-row, and the delegated `input`
  listener (line 2036) that re-sizes on typing and mirrors the value into `title`.
  Zone rhythm: inter-tier gap 45px (`.govgroup`, line 320) vs the 14px within-tier
  card gap — ~1.5x the old even 30px, so the three tiers scan as groups.
- Growth is instant (no height transition): the field tracks content exactly, the same
  contract as a native textarea.
- Evidence stills: `panel-governance-*` — Vocabulary scans as three short eyebrow
  blocks; both fixture descriptions fully readable across wrapped lines.

## 12. Terminal open state machine

- What: "Open terminal" disables itself on click (line 2268); when the session ends or
  drops, the button returns reading "Open a new terminal". No animation; the click
  affordance exists only while a click would do something.
- Evidence stills: `panel-terminal-*` (live session inside the framed dark canvas).

## 13. Not-connected gating of box-dependent primaries (iter 5)

- What: while the panel is NOT connected (whoami failed, or no rock is
  configured on this computer), every box-dependent primary action is gated —
  "Add a member" (header + empty-state), Refresh, the Add member / Add person /
  Approve / device-link / Remove / Open-terminal / catalog-sync / restart buttons.
  Gated = the established neutral disabled style (card-2 fill, soft-2 text),
  `disabled` so the handler is dead and the cursor is `not-allowed`, plus a
  "Reconnect first" title hint. The ONLY live actions in the error state are the
  recovery affordances (Try again, Technical detail) — no dead-end CTAs (the
  iter-4 replacement round's real find: "Add a member" stayed live and led
  nowhere while Not connected).
- Where: `GATED_IDS` + `connGate()` (lines 1046-1073), wired into the existing
  connect state machine: `connGate(true)` on whoami success (line 1090),
  `connGate(false)` on whoami failure and on the no-rock boot path.
  Buttons with their own arming logic (Save and publish, skill push, teardown,
  org-delete) stay under that logic; the restart button re-arms from its ack
  checkbox only while connected (line 2381, `state.connected` guard).
- Re-enable is symmetric: a successful connect removes the gate and the hint;
  the restart button returns to its own unarmed state, never straight to live.
- No animation: gating is a data-state render, same as the rest of the panel.
- Evidence stills: `panel-error-gated-*` (viewport crop: gated Refresh +
  "Add a member" in the header, live Try again in the error card, both themes);
  `panel-error-*` (same state, full page). DOM-verified: disabled + title +
  not-allowed cursor on all gated ids; a force-click on the gated "Add a
  member" does not navigate.

## 14. Disclosure chevron grammar (iter 5)

- What: every chevron disclosure family — Housekeeping folds (`secfold`),
  advanced folds (`adv`), the connect-guide steps (`guide-steps`), and the
  error-detail folds (`.connerror` / `.errbox`) — wears ONE marker treatment:
  a fixed 16px inline-flex box holding a 10px ▸ glyph in --soft-2, 6px from the
  label, rotating 90° when the fold opens. Replaces the bare ▸/▾ text glyphs
  that sat glued to summary text (and the error-detail summaries that had lost
  their native marker entirely).
- Where: one CSS block, lines 393-411 (marker box + `[open]` rotation +
  per-family gap compensation so the visual gap is 6px in every family).
- Duration/easing: 120ms transform transition on the marker; instant under
  reduced motion (line 468). The `?` info-disclosures keep their circled-?
  treatment — they are "what's this" affordances, not fold chevrons.
- Evidence stills: `panel-actions-*` (Housekeeping folds + "Advanced (optional)"
  adv fold), `panel-error-late-*` (error-detail fold, open = rotated),
  `panel-help-*` (guide-steps fold, open). DOM-verified: 16px box, 10px glyph,
  matrix(0,1,-1,0,0,0) when open.

## 15. Actions + Governance zone rhythm (iter 5)

- What: the gap BETWEEN zones is 45px (~1.5x the 30px used within a zone), so
  Actions reads as four groups — decision zone / add-member / passive
  (invite-wait + device activity) / housekeeping — and Governance as three
  tiers, instead of one even column.
- Where: `.zonegap` (line 204) on the existing zone-start elements (the
  "Add a member" subhead, `#inviteWaitWrap`, `#activitySec`, the Housekeeping
  eyebrow row); `.govgroup` margin (line 320). Margin collapsing keeps 45px
  authoritative whichever pebble of a zone wrapper is visible first. No markup
  restructuring — classes on wrappers that already existed.
- No animation. Evidence stills: `panel-actions-*`, `panel-governance-*`
  (computed margins DOM-verified at 45px on all five zone starts).

## 15b. Sticky governance Save (banked polish)

- What: the governance form runs ~2000px, so when the pagehead's "Save and publish"
  scrolls out of view a compact bottom bar (card fill, hairline top border, shadow-2)
  appears carrying the SAME action. The sticky button is a pure delegate: its click
  calls `#govSave.click()` and its disabled state mirrors `#govSave` via a
  MutationObserver, so there is exactly one save handler and one arming path.
  Visibility is an IntersectionObserver on `#govSave` gated on `offsetParent`
  (section actually displayed), so tab switches can never strand the bar.
- Where: CSS `.stickysave` (panel.html, after the governance-form block), markup
  `#govSticky` inside the governance section, wiring IIFE directly under the
  `#govSave` click handler.
- Duration/easing: entrance `stickyin` 180ms ease (translateY 10px + fade), inside
  the panel-transition budget. Hiding is instant (display:none).
- Reduced motion: `.stickysave.show{animation:none}` in the single reduced-motion
  block — the bar just appears, no slide-in.
- Evidence stills: `panel-governance-sticky-*` (viewport crop, scrolled 1200px:
  pagehead Save off-camera, sticky bar pinned bottom) vs `panel-governance-*`
  (top of page, no bar).

## 16. Reduced-motion contract (single block)

`@media (prefers-reduced-motion: reduce)` (panel.html:462-469) removes, in one place:
presence breathe (frozen ring), skeleton shimmer (static lines), modal entrance
(instant), every hover transition, the sticky-save slide-in (§15b), and the
disclosure-chevron rotation (fold state still changes, marker snaps instantly).
Nothing else in the file animates, so the block is exhaustive by construction.

## Screenshot inventory this file pairs with

46 shots, 23 states in each of light and dark: fleet rich (`panel`, hot triage chips +
3+2+2 grid, glossed card meta: "core tier · region sin · microsoft · 2 packs" with
full-word titles), loading + skeleton-mid (deterministic shimmer pair, frozen at two
known sweep offsets), empty, error, error-gated (viewport crop: connection-gated
header primaries), error-late (retries + open detail), people, skills (+ checkbox
double-ring focus), actions rich (triage: waiting decisions; 45px zone rhythm), actions
empty (quiet rows), invite-midstep (steps board running + "Adding…" in-flight button),
invite (complete flow + send box), governance (three labeled tiers, sub-grouped
Vocabulary with descriptive de-duplicated labels, full-width descriptions), orgbrain,
terminal (live), danger (unarmed destructive: neutral fill + destructive-tinted border
and text, 7.59:1 light / 6.80:1 dark), help (modal), plus four keyboard-focus evidence
shots per theme: focus (nav item), focus-primary (Add a member), focus-input (accent
border + card-gapped double ring), focus-modalclose (modal close button).
`console-report.json` records per-shot console errors (zero across the set).
