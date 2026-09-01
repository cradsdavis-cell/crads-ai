# Small-surface flow notes: door · member-connect · wizard · join (ui-overhaul iteration 2)

Companion to the `small-shots.mjs` evidence set (23 states × 2 themes, console-clean).
Screenshots are stills; this file records the motion and interaction behaviour that
cannot appear in a PNG, with line refs into the four files as committed.

## Shared foundations (all four surfaces)

- **Tokens**: each file carries an inline copy of `wizard/panel/vendor/tokens.css`
  (light-first, dark via `prefers-color-scheme`), header-commented to the canonical.
  The inline block is a resilience fallback; since commit 2034f00 all three servers
  (`door-server.mjs`, `member-connect.mjs`, `ui/server-lib.mjs`) ALSO serve `/vendor/*`
  (tokens.css + inter/, one-subdir-deep, panel/vendor as source of truth), so Inter
  loads in production on door, connect and the wizard exactly as on panel/member.
  The join page ships as a lone static file on crads-ai.com and keeps system-stack
  fonts by design.
- **`--edge` boundary token (iteration 2, door + connect)**: click-target cards and
  fold rows carry a rest border one visible step up from `--line`:
  `color-mix(soft 45%, line)` light / `color-mix(soft 35%, line-2)` dark, pixel-sampled
  2.13:1 / 2.98:1 vs paper (old `--line` sat at 1.20 / 1.76). Containers that are not
  click targets (connect's invite card, wizard cards) stay on `--line` + shadow.
- **Dark card definition**: dark `--card` steps to `#262E25` / `--card-2` to
  `#2C342B` on `body` (member.html iteration-8 proven fix; tokens' dark card is
  1.10:1 vs page and dissolves).
- **Focus grammar**: every interactive element takes the tokens' double ring
  (`--focus`, paper-gap + accent) via `:focus-visible`; inputs also flip their border
  to accent. Focus evidence shots: `door-focus-*`, `connect-focus-*`,
  `wizard-focus-*`, `join-focus-*`.
- **Disabled buttons**: never an opacity wash over accent (member iteration-9 rule);
  disabled = `--card-2` fill + `--soft-2` ink + (banked polish) a `--line-2` border,
  so the retired silhouette keeps a visible boundary against the card (the card-2
  fill alone sits at 1.09-1.15:1). On camera in `connect-approved-*` (the retired
  redeem button).
- **Zero em dashes** in copy; sentence case; one accent CTA per screen state.
- **Rig**: `small-shots.mjs` shots may carry an `init(page)` hook that runs before
  `page.goto` (addInitScript / `page.route` holds); this is how the door loading
  state and the wizard fail state are staged without touching the harness.

## Door (`wizard/panel/door.html`)

- **Card boundary + hover (iteration 2)**: identity cards are the page's only click
  target, so they earn a stronger step than the certified surfaces: rest border
  `--edge` + shadow-1; hover flips the border to accent, tints the card
  `color-mix(accent 6%, card)` (pixel-verified vs the un-hovered card: 1.08 light /
  1.11 dark, a tint not a fill), lifts 2px to shadow-2, and slides the chevron 3px
  into accent. Hover shot: `door-hover-*` (sampled accent border 4.80 light / 6.23
  dark vs paper). Active presses back to rest.
- **Hierarchy anchor (iteration 2)**: the identity opened last leads with a 3px
  accent left rail + a LAST USED micro-chip. Recency is local-only: `/identities`
  returns no recency data, so the door stores `aios_door_last` in localStorage when
  a card is clicked. With no record yet, the FIRST row carries the rail alone as the
  primary pick (rail without the chip; the chip never claims recency that does not
  exist). Rail sampled 4.80 / 6.23 vs paper. The rig primes localStorage so
  `door-*`/`door-hover-*`/`door-focus-*` show the returning-user composition.
- **Loading skeleton (iteration 2)**: while `/identities` is in flight the list
  holds two shimmer card-skeletons (member.html grammar: `--skelfill` =
  mix(soft 25%, faint), white glint sweep). Fill sampled 3.55 / 3.68 vs the card.
  First load only (`state.loaded` guard: a `/forget` reload never re-flashes it).
  Shot `door-loading-*` (rig holds the `/identities` route). Reduced motion freezes
  the sweep.
- **Presence dot breathe**: `.dot.ok::before` ring scales .55→1 and fades .45→.12
  over a 3s ease-in-out loop, identical grammar to member.html. `err` and checking
  dots are static. Stills: `door-*` (green) vs `door-pending-*` (red static + warn
  subs + forget links).
- **Reduced motion**: breathe frozen, transitions off, no hover lift, no shimmer.
- The old dense footnote lives as per-row `title` hints (render(), b.title) and
  per-state sub lines; the foot is one mono line.

## Member-connect (`wizard/panel/member-connect.html`)

- **Triage**: one primary path (invite card, the page's only accent CTA at rest);
  the secondary paths + manual 3-step flow sit behind `details.fold` disclosures
  with the shared chevron grammar. `connect-*` = folds closed; `connect-expanded-*`
  = manual + rocks open.
- **Fold-row boundary (iteration 2)**: fold rows are click targets → rest border
  `--edge` (sampled 2.13 / 2.98 vs paper); hover is a strong NEUTRAL step (border
  `--soft`, `--card-2` tint, shadow-2 lift): perceptible without borrowing the
  accent, which this page reserves for its one CTA (iteration-5 resolution of the
  perceptibility-vs-accent-bleed judge pair). One fold opens at a time (accordion);
  the manual fold's gated steps carry LOCKED chips and step 1 gains a check mark
  once its key is created. The invite
  card is a container, not a click target: it stays on `--line`.
- **Nesting relief (iteration 2)**: inside the manual fold, only UNLOCKED steps
  render as bordered cards (`--line` border + shadow-1 + `--card`); gated steps are
  flat `--card-2` wells with no border (`border-color:transparent`), so the fold
  never reads border-in-border-in-border at rest. Pixel-verified on
  `connect-expanded-*`: the strongest edge across the gated step-2 boundary is the
  well transition itself (1.26 light / 1.20 dark; a border ring would sample ≥1.5).
  After `genBtn` unlocks steps 2+3, all three render as live bordered cards
  (`connect-manual-keyed-*`).
- **Steps 2/3 gating** (d392a15, verified this round): token-dimmed, never opacity:
  `--soft-2` text (6.03+ on the well), muted controls on `--line-2` borders, and the
  step coin flips to a `--card` fill so it still reads on the well. Pointer-events
  off until unlocked.
- **Fold auto-open**: flows that resume or complete inside a collapsed fold pull it
  open: `openFold()` fires from `joStatusTick` (every ask-to-join stage) and
  `showClaudeAlias` (the moment a connection name exists). On camera:
  `connect-approved-*` shows the Claude Code fold self-opened with the connection
  name filled.
- **Redeem lifecycle**: redeem button disables on success (its job is done; accent
  moves to "Open my dashboard"), stays enabled on error for retry.
- **Org rows**: door card anatomy: name + mono claim sub-line left, chips right
  (`connected here` = good chip; role / status / `rock-owned box` = quiet
  chips). The 2026-07-24 review contracts survive verbatim (`esc(o.org)`,
  `o.owner === 'org'` gating, `st + own` composition); `my-orgs-routes.test.mjs`
  static checks green.
- **Reduced motion (connect's own contract)**: one media block kills every
  transition on this surface (inputs/selects, .act buttons, fold rows, kind tabs,
  openlink) and the busy spinner freezes to a static ring; active-press transforms
  are also disabled. Nothing on connect animates under prefers-reduced-motion.
- No brand lockup: member-adjacent chrome (design-language § brand lists
  door/wizard/join only; D23 leaning).

## Wizard (`wizard/ui/index.html`)

- **Adaptive intro (iteration 2)**: the full orientation block (lead paragraph +
  "What am I actually setting up?" + cross-links, each cross-link on its own line)
  renders on step 1 ONLY. From step 2 on it collapses to a single quiet
  `details.info` line, "Setting up the hub for <org> · what is this?", with the
  whole orientation one chevron away. The org name updates from the step-1 field.
  Shots: `wizard-*` (full, step 1) vs `wizard-step2-*` (collapsed).
- **Progress segments (iteration 2)**: inactive segments are a state indicator, so
  their fill moved off `--line-2` (1.41 / 1.76 vs paper, invisible) to
  `color-mix(soft 25%, faint)`, pixel-sampled 3.26 light / 4.63 dark vs paper.
  Active stays accent.
- **Done-state CTA (iteration 2)**: the stream parser harvests two facts on the way
  past: the hub URL (engine `  URL: https://…` line, or the older
  `cloudflare access wired: <host>` form) and the `  Password: …` line. On
  `__DONE__`: key-installed keeps its `/panel` primary (unchanged); otherwise a
  harvested URL becomes a filled "Open your control panel →" button and the
  password surfaces inside the card as a copyable mono `.fact` row (log stays the
  fallback wording when neither exists). Re-runs reset the harvest. On camera:
  `wizard-provision-done-*` (fixture emits the wired-host line → primary CTA).
- **Failure path**: errbox + accent Try again + failed ✗ step row; Back re-enabled.
  Shot `wizard-provision-fail-*` (rig routes `/provision` to a failing SSE stream).
- **Provision = steps board + mono log** (no bare spinner): `▸ stage…` section
  markers become typed rows (pending `--soft`, running ink + `…`, done `--good` ✓,
  failed `--bad` ✗) while every raw line still lands in the dark mono log.
  `wizard-provision-mid-*` catches the board part-done mid-stream.
- **Help disclosures**: all per-field `details.info` and per-service `guide-steps`
  are quiet `--soft-2` chevron rows; accent on this page is reserved for Continue,
  inline hyperlinks, and the one member cross-link.

## Join (`wizard/join-page/index.html`)

- **Bad-link recovery (iteration 2)**: the error card now recovers instead of
  dead-ending. (a) a "Paste the full invite link" input re-runs `parseJoinFragment`
  on every input/paste (accepts a full URL or a bare fragment); a complete invite
  replaces the hash and reloads straight into the normal flow. Incomplete pastes
  only earn the inline error once the text is plausibly a whole paste (>24 chars),
  so typing never nags. (b) A quiet "Try opening the app anyway" link fires the
  `crads-ai://` scheme with the raw fragment. Keyboard path: Tab lands on the
  input, then the link. Shot `join-badlink-*`.
- **Ghost button (iteration 2)**: border moved `--line-2` → `--faint`
  (pixel-sampled 3.08 light / 3.16 dark vs card; old border sat at 1.53 / 1.40);
  hover strengthens to mix(soft 30%, faint) + a `--card-2` fill. Primary vs ghost
  differ by weight too: 650 filled vs 500 outline.
- **Fine print rhythm (iteration 2)**: `.fine` up to 14px top margin; the foot is
  two facts on two rows with 14px between them.
- **App-probe spinner**: the "Opening the app…" state keeps its 0.8s spinner;
  reduced-motion freezes it to a static ring. Now on camera: `join-opening-*`
  (captured inside the 2s probe window before the download fallback swaps in).
- **Error text** (`.err`) mixes 75% `--bad` toward ink (5.54 dark / 7.47 light on
  the card).
- `parseJoinFragment` / `downloadFor` untouched, byte-for-byte in lockstep with
  `join-parse.mjs` (its test suite green).
- **STILL OPEN (banked, out of scope for this repo)**: the join page renders in
  system-stack fonts, not Inter. It ships as a lone static file hosted on
  crads-ai.com, so vendoring Inter next to it (or inlining it) has to happen in
  the samdavis-site repo, which this loop does not touch. Revisit when that repo
  is in hand; until then the system stack is the deliberate fallback.

## Contrast samples

Iteration-2 pairs are PIXEL-SAMPLED from the shot PNGs (peak pixel across the
boundary, vs the named reference); iteration-1 rows were computed from token hexes.

| pair (iteration 2, pixel-sampled) | light | dark |
|---|---|---|
| door/connect `--edge` rest border vs paper (was `--line` 1.20/1.76) | 2.13 | 2.98 |
| door hover border (accent) vs paper | 4.80 | 6.23 |
| door anchor rail (accent) vs paper | 4.80 | 6.23 |
| door hover tint vs un-hovered card (a tint, not a fill) | 1.08 | 1.11 |
| door skeleton fill vs card | 3.55 | 3.68 |
| wizard inactive progress segment vs paper (was `--line-2` 1.41/1.76) | 3.26 | 4.63 |
| join ghost border vs card (was `--line-2` 1.53/1.40) | 3.08 | 3.16 |
| connect gated step edge (no border by design; peak = well transition) | 1.26 | 1.20 |

| pair (iteration 1, token-computed) | light | dark |
|---|---|---|
| join `.err` on card (was raw `--bad`, dark 4.28 FAIL) | 7.47 | 5.54 |
| warn "waiting" sub on card (door pending) | 5.18 | 6.96 |
| `--soft-2` meta on card / paper / card-2 | 6.95 / 6.37 / 6.03 | 6.62 / 8.33 / 6.08 |
| steps-board done `--good` on card | 4.95 | 5.22 |
| chip good-mix (80% good→ink) on card | 6.07 | 6.27 |
| accent text/links on card | 5.24 | 4.96 |
| on-accent on accent buttons | 5.24 | 6.57 |
| mono log inks on `#171D18` (base/ok/err) | n/a | 9.29 / 8.21 / 6.72 |

Known quiet pair, by convention: form-input rest borders stay `--line-2`
(1.53/1.40 vs card); it is the system-wide input treatment on the certified
panel/member surfaces; inputs signal on hover (`--faint`) and focus (accent ring).

## Evidence inventory

46 shots in the run directory (`small-shots.mjs --out …/iter3-small`), all
console-clean: door ×6 states (default, empty, pending, loading, hover, focus),
connect ×6, wizard ×7 (step 1, focus, step-2 collapsed intro, accounts, mid,
done, fail), join ×4 (fallback, opening, badlink, focus), each × light/dark.
Functional gates: `node --test wizard/panel/*.test.mjs wizard/ui/*.test.mjs
wizard/join-page/*.test.mjs` → 149/149 pass.
