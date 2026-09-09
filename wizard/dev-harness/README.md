# dev-harness — local fixture server + screenshot rig

Dev-only tooling for the UI overhaul (`docs/superpowers/specs/2026-07-25-ui-overhaul-design.md`).
Serves the surviving UI surfaces (the one shell + the door; the invite
connect/join pages and the org wizard were deleted 2026-09-01) with realistic
mock data so Playwright (or a browser) can exercise them without a real box.
Never shipped, never touches live systems.

## Start the harness

```sh
node wizard/dev-harness/harness.mjs            # default port 4610
node wizard/dev-harness/harness.mjs --port 5000
```

| URL | Surface | Real file served (unmodified) |
|---|---|---|
| `/panel` | The one shell | `wizard/panel/member.html` |
| `/member` | The one shell (same file) | `wizard/panel/member.html` |
| `/door` | Identity chooser + self-host create | `wizard/panel/door.html` |

Fixture world: org **driftwood-surf** (7 members across every status/risk level,
3 operators, 3 skills, governance doc, org brain) and member **Mel Harper**
(12-page brain + graph, dashboard, cadence, sharing, support log). All names and
emails are fictional. Data lives in `fixtures.mjs`.

## States

Append `?state=` to a surface URL; every API call the page makes inherits it
via the Referer header (no surface file is modified):

- default (`rich`) — fully populated org/member
- `?state=empty` — brand-new org/member: no members, no pages, onboarding banner
- `?state=error` — every `/run` verb fails like a dead box (SSH timeout)

Cookie fallback for tools that strip referers: `GET /state/empty` (or
`rich`/`error`) sets it globally.

## Page switches

Beyond the three worlds, a surface URL can carry a switch the stubs read the
same way (referer first, then the request's own query). Used by the docs
shots (`docs/product/pipeline/shots.mjs`, `query:`):

- `/door?provision=booting|ready|failed`: the self-host wizard's own
  "re-enter the flow" read lands on the build screen, the finish checklist,
  or (booting on the first poll, failed on the next) the failure with Retry
  and Remove. Without the switch, driving the page (Check the token, Build
  it) walks a stubbed run starting → provisioning → booting → ready across
  status polls. A token containing `bad` is refused at Check.
- `/provision/providers` answers the real registry (Hetzner, DigitalOcean);
  validate answers a catalogue in the picked provider's currency (`provider`
  in the body), Sydney-first for DigitalOcean.
- `/door?setup=done`: the finish checklist's GitHub and Claude chips read
  Done instead of Not yet.

## Stubbed endpoints

`/targets`, `POST /run` (all panel + member verbs, streamed over the real SSE
line protocol), `/term/open|stream|input|close` (fake pty with an ANSI
transcript + keystroke echo), `/update-status`, `/update-apply`,
`/org-teardown` (always refuses), door (`/identities`, `/probe`, `/forget`),
member-connect (`/my-orgs*`, `/join-org/*`, `/own-brain/*`, `/redeem`, `/test`,
`/generate`), wizard (`POST /provision`, paced SSE build log).

## Screenshots

```sh
cd wizard/dev-harness
npm i                      # installs playwright (chromium build is cached in ~/.cache/ms-playwright)
node shots.mjs             # boots its own harness on port 4611
```

Writes full-page PNGs for every surface × light/dark (plus panel/member in
empty + error states, an open terminal, and the member Brain graph) to
`docs/superpowers/ui-overhaul/shots/baseline/`, and a per-shot console-error
summary to `console-report.json` in the same directory. Both are gitignored.
Flags: `--out <dir>`, `--port <n>`.
