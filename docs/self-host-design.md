# Crads-AI self-host design (the 2026-09-01 pivot)

Status: DECIDED (Sam, 2026-09-01; full rulings in second-brain decisions/log 2026-09-01).
This doc is the build spec for the stripped-back system and the record of the open calls.

## 0. The ruling, in one paragraph

Crads-AI becomes **free, open-source, fully self-hosted**. A person creates their own
mineral on their own Hetzner account with their own API token; provisioning runs
**locally in the desktop app wizard** and the token never leaves their machine. There is
**nothing central**: no directory service, no door, no invites-to-provision, no billing,
no crads-ai.com subdomains, no DNS or tunnels operated by us. A rock is a **community
hub with no metal**: it can never create, own, or access a pebble it does not own.
Revenue comes from services (guided setup, hourly support, paid rock-onboarding), never
from the software. Ownership follows payment: whoever pays Hetzner owns the box,
holds the only key, and answers for the data on it.

## 1. What was removed (done 2026-09-01)

- **Metal:** all Sam-hosted Hetzner servers deprovisioned (6 boxes; snapshots named
  `pivot-archive-<slug>-20260901-delete-after-20260930` retained to 30 Sep, then deleted).
  `aios-the-oracle` kept (Sam's own mineral). DNS + tunnels cleaned by the deprovision
  scripts; state files archived per house rule.
- **Cockpit:** fulfilment ring off (`cockpit-fulfil.path`/`.service` disabled; crontab
  entries for billing-state, enrol-arrivals, fulfil-promotions, release-watch,
  billing-watch commented with dated reason). Crads billing state archived to
  `cockpit/archive/2026-09-01-self-host-pivot-state/`.
- **Worker:** create/build/billing/lockout/licence/stripe routes stripped (branch
  `self-host-strip`); T10/org-consent/rate-limit create gates removed with the create
  path they guarded.
- **Site:** /app control plane, join/open/paid landings, invite courier, pricing and
  billing archived (branch `self-host-strip`); docs + downloads survive; the coaching
  business untouched.
- **Stripe:** every crads_ai subscription was already canceled (26 Aug sweep); verified
  clean 1 Sep. The crads price objects and 2 customers remain as inert history.

## 2. The wizard (the whole onboarding, one flow)

The desktop app gains a **"Create your mineral"** wizard. It replaces the door, the
invite email, the concierge form, and the $500-of-Sam's-time. Design target: the
cohort-one stuck-list (B1 identity mismatch, B2 stale-SSH, B3 Claude sign-in, B6 cost
surprise) each dies by construction or gets a wizard step.

Steps, in order, all local:

1. **Costs, up front.** First screen states the real costs before anything is created:
   Hetzner server (~AUD $12-16/mo for cx33-class), Claude subscription (theirs), $0 to
   Crads-AI. B6 dies here.
2. **Hetzner.** Guidance to create an account + project + read-write API token (with
   screenshots); token pasted into the app, held in memory / OS keychain only, never
   sent anywhere but api.hetzner.cloud. The wizard validates the token with a
   read-only call before offering Create.
3. **SSH identity.** Wizard generates (or reuses) an ed25519 keypair in `~/.ssh`, and
   the public key goes into the server create call. **Ownership by construction**: the
   only key on the box from first boot is the user's. This replaces the door, the
   identity match, and T9's central relay. Known-hosts handling: the create response's
   host key (or first-connect scan, prompted once) is written to the app's known_hosts
   so the bundled ssh2 never hits the accept-new failure.
4. **Create.** `POST /servers` with the public image, cloud-init from the template
   (minus operator keys, arrival hooks, and directory registration), progress polled
   via the Hetzner action API. No build-progress service; the wizard IS the progress bar.
5. **GitHub brain repo.** GitHub device-flow sign-in; create a private repo
   (`<name>-brain`); deploy key from the box added via API; box pushes its brain there
   on the existing sync cadence. Their data, their backup, their account.
6. **Claude sign-in.** The wizard opens the SSH session and walks `claude setup-token`
   (or the current auth flow) interactively, with the B3 failure documented inline.
7. **Done.** SSH config Host block written, app connects, Getting Started page opens
   (delivered via the pack/pages surfaces that shipped 24-26 Aug).

Failure handling: every step idempotent and resumable; a half-created server is shown
with a "destroy and retry" button that uses their token (never silently re-billed).

## 3. Rocks as hubs: the commons-repo model

A rock stops being a box that can mint boxes. What remains is the thing communities
actually wanted (B5: "members want skill sharing"): a **curated commons**.

- **The commons repo** is a git repo on the ROCK OWNER'S GitHub (e.g.
  `<org>-commons`). The rock owner (or their paid onboarding) curates skills, packs,
  prompts, and pages into it. This is the "middle ground repo": the only shared
  surface between a rock and its members.
- **Joining** = being granted read access to the commons repo (GitHub ACL does all the
  work: private repo + invited collaborators, or just a public repo for open
  communities). No directory KV, no tie records, no stamps. A member's box adds the
  commons as a read-only remote.
- **Delivery** = pull, not push. The member's box syncs the commons on its existing
  cadence and surfaces new items through the inbox-pickup delivery model ("ships like
  skills", built 24-26 Aug). Installation stays a member-side act with the existing
  lint/sandbox pass. Nothing the rock does can execute on a member box without the
  member installing it.
- **Isolation, both directions, by construction:** the rock holds no credential for
  any member box or brain repo; the member holds nothing of the rock's beyond
  read-only commons access. Revocation = GitHub access removal; the member keeps what
  they installed (17 Aug ruling 7 carries over). Member share-back stays parked; if
  wanted, it is a GitHub PR to the commons, reviewed by the owner — no custom machinery.
- **A rock MAY still run its own mineral** (on its own token, via the same wizard) for
  the org-brain/enclave use case. That box is just another self-owned mineral that
  happens to push to the commons.

Security notes (the "research" answer): this model removes every standing service that
could be attacked (no create endpoint, no token custody, no cross-tenant control
plane). Residual risks and answers: (a) malicious commons content → member-side
sandbox/lint + install-is-consent, same as any package manager; recommend the docs say
"join commons you trust" and we keep the page-lint sandbox mandatory on install;
(b) impersonation of a commons → the join bundle is a git URL exchanged
person-to-person inside the community (out of band), not discovered through us;
(c) GitHub as the trust anchor → acceptable; it is also the brain-backup anchor.

## 4. Retirement path for what still runs

| Thing | Depends on it today | Path to zero |
|---|---|---|
| directory worker (directory.crads-ai.com) | T9 device-enrol relay for the-oracle + Sam's devices; edges/minerals reads (site pages now gone) | Wizard-local key management replaces T9 (the owner edits authorized_keys over SSH via the app). When the-oracle no longer needs the relay: `wrangler delete`, KV namespace exported to archive then deleted. Target: with the extraction release. |
| site auth (app JWKS/tokens) | desktop app sign-in, worker token trust | Dies with the worker; the app stops needing an account at all (identity = SSH key). |
| GHCR images | the-oracle updates; future self-hosters | ALREADY PUBLIC (crads-rock/-pebble/-base + ai-os-member answer anonymous pulls; in-repo audit note 2026-08-20, re-confirmed during the 1 Sep strip). Nothing gates self-host pulls today. |
| docs on crads-ai.com | product docs | Stays. Site becomes docs + downloads + (separate) coaching business. |
| brain-template privacy | vendored into images | Extraction copies it in; hardcoded `directory.crads-ai.com` in 7 files becomes deployment config (the product decision flagged 26 Aug is now made: config, because "one image, N deployments" is real for self-hosters). |

## 5. Fresh extraction (the open-source release)

- **New public repo**, clean history; ai-os stays the private working repo. Copied in
  deliberately: engine/, rock-machinery/, wizard/ (app + new provisioning wizard),
  Dockerfiles + bake, brain-template (vendored), docs pipeline + pages, provisioning
  templates (rewritten for self-host). NOT copied: harness/, cockpit hooks, operator
  scripts, anything with client references, the whole git history.
- **Secret + privacy audit before flip:** clean-gate personal wall over the extraction
  tree; grep for tokens/emails/client names; the untracked `harness/kv-backup-*` and
  `stripe-backup-*` dirs never enter the extraction; docs pages rewritten off the
  hosted/billing copy (coverage.mjs + legal-lock will enforce nav coherence).
- **License: OPEN.** Options on the table: AGPL-3.0 (protects against third-party
  hosted commercialisation, keeps a future hosted lane defensible) vs Apache-2.0
  (adoption + portfolio optics). Decide before the repo flips; nothing else blocks on it.
- **Naming/branding:** stays Crads-AI unless Sam renames at release.
- Nothing goes public until: extraction audit passes AND Harriet has heard the plan.

## 6. Money (so nobody pretends otherwise)

The software can never produce subscription revenue again. Paid surfaces that remain,
all services: **guided setup** (fixed fee: zero → working mineral on their own
accounts, wizard-assisted), **hourly support/coaching**, **paid rock-onboarding**
(community leader: commons repo set up, content curated, members onboarded). The old
$35/mo pass-through, seat fees, and tier pricing are gone with the billing code.

## 7. Owed / open

- Wind-down comms to the hosted-era community (with the snapshot-restore offer
  to 30 Sep): drafts exist, sends are the operator's.
- Legacy Hetzner project: token dead; check the console for anything still billing.
- License call (§5). Extraction execution (multi-day). Wizard build to finish.
- the-oracle stays on the old machinery until the wizard can re-home it (Sam said
  leave it alone; nothing forces a move).
- 40 GitHub test-repo deletions + laptop ssh cleanup (carried from the blank slate).

## 8. Addendum — what the 1 Sep strip run established

- Strip landed on `self-host-strip` (worker −6,710 lines net across 51 files; full
  suite 3,021/3,030 with both failures pre-existing on hardening-loop). Kept, by
  judgement: /build-progress (promote flow reads it), promote + join families
  (no metal), invite verbs (fail closed: rocks receive no HCLOUD/CF/GITHUB tokens
  at all now, so their stamp path refuses legibly).
- Wizard provisioning engine v1 in `wizard/provision/` (hetzner.mjs client +
  selfhost-cloudinit.mjs renderer + engine.mjs orchestrator + live-cert.mjs
  driver, 6/6 unit tests). **LIVE-CERTIFIED 2026-09-01** on a throwaway box
  (aios-cert-selfhost, created and destroyed same hour): engine end-to-end on a
  real token; box boots from the rendered cloud-init; public :v2 pebble image
  pulls anonymously; SSH with the owner's birth key lands INSIDE the running
  container via enter-aios; 80/443/7780/7781 closed, 22 open; zero platform
  credentials aboard. Five findings, all fixed or absorbed: (1) Hetzner's
  create action reports success while the server is still 'starting', so the
  engine polls the server, not the action; (2) one dropped socket must not
  fail a wizard run — the client retries network errors ×3 (Hetzner name
  uniqueness turns a double-create into a legible 409); (3) host scripts
  (enter-aios + aios-host-update) must be injected at the #__HOST_SCRIPTS__
  marker — without them sshd's ForceCommand locks every SSH out of a booted
  box; (4) undici's fetch can time out on IPv6-less hosts where raw IPv4
  works — the engine accepts any fetch-shaped impl, and the cert driver ships
  an node:https IPv4 one; (5) provider IPs RECYCLE (the cert box was handed a
  dead cohort box's IP), so the wizard must own known_hosts entries rather
  than trust first-connect state. UI wired 2026-09-01 (second pass): the door
  grew a fourth card, "Set up my own", whose flow is costs-first (B6's fix as a
  screen), then token + name + real location/size catalogues, then the engine
  with live progress, reattach-on-reentry, and destroy-and-retry; served by
  wizard/panel/provision-routes.mjs, pinned by provision-routes.test.mjs (6
  tests: key-before-birth order, token never on disk, 409 on a second run,
  destroy semantics) and driven end to end in a real browser against a fake
  Hetzner. **REAL-TOKEN UI RUN PASSED (2026-09-01, second pass):** the actual door page,
  a real token, real metal (cert-ui, cx33 @ nbg1): live catalogues rendered
  from the account, invite-to-ready in 1m54s through the page's own progress
  view, and `ssh cert-ui-box` from a plain shell landed inside the container.
  Hetzner recycled the exact IP that broke the first engine cert and the flow
  absorbed it (clear-then-pin working as designed). Box, Hetzner key, and the
  local identity all cleaned after. **Steps 5-6 SHIPPED 2026-09-02** as the
  door's finish checklist: "Your mineral is alive" is now a three-row screen
  (Open it · Back up your brain to your GitHub · Connect Claude) with live
  done/not-yet chips read from the box (`/setup-steps`, one SSH round trip:
  brain origin remote + the non-empty `/state/.claude-auth/.credentials.json`
  presence test). The GitHub step runs the EXISTING own-brain flow in place
  (own-brain-routes mounted on the door as well as the seat; device-flow
  OAuth App `Ov23lixA2dRqRtv5hfnm`, registered 2026-07-24 — not a deploy key:
  the box's uid cannot run ssh, so own-brain wires an HTTPS remote plus a
  credential helper and stores the member's token on THEIR box only). The
  Claude step deep-links the app's Terminal tab with the sign-in opener
  staged (`#box=<slug>&sec=terminal&run=signin`, run= whitelisted to the bare
  `claude`), because an interactive OAuth cannot be automated honestly; the
  checklist's poll notices when the credential file lands. Both steps stay
  reachable later where they always were: the seat's Backup card and ladder.
- **Third pass, same day (Sam's calls after walking the flow):** the hosted-era
  door cards (invitation + join-a-community) stripped; the door is now
  "Set up my own" (lead) + "I already have one". **Wizard-local device-add
  SHIPPED** (`wizard/panel/device-routes.mjs`): the old machine approves a new
  one over SSH straight to the box (offer → approve → `crads1:` bundle →
  complete), no account, no worker; key validation refuses rather than escapes,
  appends ride stdin, idempotency proven through a real shell. This is the
  replacement that unblocks retiring the account UI + T9 + the worker: the last
  central dependency now has a local successor. Ghost purge: the directory KV
  cut from 193 keys to 12 (salt/jwkscache only; full backup in
  `harness/kv-backup-2026-09-01-ghost-purge/`), so signed-in machines stop
  rendering dead minerals. Worker + site-auth + account-bar retirement is now
  unblocked and scheduled post-Snowies.
- Follow-up passes owed: convert the rock Members invite flow to
  community-membership grants (commons model); rewrite docs/product pages off the
  hosted/billing copy (coverage.mjs will police nav); member.html tie/anchor copy
  still says "hosting and billing return to Crads AI" (anchor semantics product
  call); a live PAT prints in promoted-rock-github test output on this box
  (hygiene: log out gh or scrub the resolver's test env).
