# The local face: a brain on your own computer

Design note for the no-server mode of the desktop app. Written 2026-09-11
against the `local-face` branch; the ruling it records is Sam's, the same day.

## The ruling

Crads-AI gains a no-server mode. The app opens against a brain folder on the
user's own computer, runs the panel verbs on that folder, and Claude Code runs
on the folder directly. Everything that needs a box is hidden, with one honest
line in its place: "Scheduled jobs, Telegram and connections need a server."

It ships inside the same Guided setup offer. The docs describe it as: on your
own computer, free, no schedules, only awake when you are.

## What it is, in one paragraph

A third target kind beside `member` (a `<slug>-box` alias) and `rock` (a
legacy `<org>-rock` alias): `local`, alias `<slug>-local`, listed from
`~/.crads-ai/local-brains.json` rather than `~/.ssh/config`. The one face
(`member.html`) serves it through the one panel server. The transport is
`local-bridge.mjs`, a `{targets, stream}` object like `systemBridge()`; the
verb table is `LOCAL_VERBS` (`local-verbs.mjs`), a strict subset of the member
table. The door makes one with the "On this computer" card, which scaffolds a
folder the way `engine/box-up.sh` scaffolds a box.

## The data boundary

The brain is on the user's disk and nowhere else, unless they connect GitHub.

| What | Where | Leaves the computer? |
|---|---|---|
| the brain (`wiki/`, `profile.yaml`, `onboarding-state.json`, `dashboard/`, `CLAUDE.md`) | the folder | only by the user's own `git push` to their own private repo |
| the skills | `<folder>/.claude/skills/<id>/SKILL.md`, synced from the engine files the app carries | never (gitignored) |
| the registry (which folders this app knows) | `~/.crads-ai/local-brains.json` | never |
| the GitHub token, once connected | `<folder>/.kernel/brain-github-token`, 0600, gitignored | only to api.github.com, by the user's own git |
| Claude sign-in | the user's own Claude Code install on this computer | not the app's business at all |

There is no server-side anything: no ssh key, no known_hosts entry, no
device roster, no vault, no support grant, no heartbeat. The app never dials
anything for a local target. `door-server`'s `/probe` answers "ok" if the
folder exists; `/forget` drops the registry row and leaves the folder alone.

## What is hidden, and why

Hidden on the local face (CSS on `body[data-face="local"]`, nothing deleted
from the markup because the exe smoke greps every section):

| Surface | Why it needs a server |
|---|---|
| Connections page + nav entry | MCP tokens live on the box and serve its scheduled jobs; there is no headless runner here |
| Secrets page + the Privacy group | the vault and the hot tier are box stores; the cold tier seals to device keys a folder does not have |
| Terminal page + nav entry | `ssh -tt` into a box; on your own computer your terminal is right there, and Claude Code opens the folder |
| Every computer that can open this (seat) | the device roster is sshd's authorized keys |
| Waiting on you (seat) | rock-era asks; nothing can stage one on a folder |
| the cadence gate, Save schedules, every row's switch, cadence chip and schedule editor, Run now | the scheduler is the box's kernel; nothing fires while the folder is closed |
| Health card machinery rows | the always-on jobs do not exist here |
| Help: connection name, Update and restart, Support access | ssh, the image update channel, and a time-boxed sshd grant |

Each hidden group carries `<p data-needs-box-note>` with the one line. The
ladder's server capabilities (scheduled tasks, add a device, email + calendar,
Telegram) read "Not yet" with "Needs a server. This brain lives on this
computer." rather than offering a button into a hidden page.

Shown instead: Help gets "Your brain folder" (path + copy + "Open this folder
in Claude Code" steps); the seat's Hosting row says "This computer" and the
Backup card offers GitHub only (a download of a folder already on this disk
would be a copy of a copy); the Overview banner and hero button land on Help.

## The verbs, and how they run

The box verbs shell `node /app/engine/...` and POSIX `find | sed | base64`
over ssh. Two facts about the people this face is for force a different
shape: most are on Windows, which has no POSIX userland by default, and the
packaged exe is a single-executable node whose main is fixed, so it cannot
spawn `node some-script.mjs` even where node is installed. So:

- `LOCAL_VERBS` builders emit `__local__ {"verb","args"}` markers, validated
  exactly as the member builders validate (a bad page path is a 400 before the
  folder is touched), and `local-bridge.stream` runs them IN-PROCESS through
  `runLocalVerb`.
- Anything else is a plain shell line with cwd = the folder: `bash -lc` on
  linux/darwin, `cmd.exe /d /s /c` on win32 (`shellFor`, tested). `whoami` is
  the one shell verb and doubles as the liveness check.
- Engine logic that had to come along is imported directly where it is a
  function (`listSkills`, `deletePage`, `syncSkills`, `readClaudeCredential`)
  and ported where it was a script (`seed-pages`, `init-state`, `name-set`,
  and a trimmed `box-cockpit` for the Overview: onboarding, the brain graph,
  skills installed; no Telegram, cadence or Claude sign-in rows, because
  claiming any of them for a folder would be false).
- The engine FILES a folder is born from (the eleven `engine/skills/*.md`,
  `interview-spec.yaml`, `profile.schema.yaml`, `brain-ignore.txt`, the
  appshell templates, `local-claude-md.md`) ride the SEA asset map on both
  platforms under their repo-relative paths (`LOCAL_ASSET_FILES`, pinned by
  `selfhost-assets.test.mjs`; `local-scaffold.test.mjs` pins the skill list
  against the directory).

Served: `whoami`, `dashboard-data`, `brain-list`, `brain-read`, `brain-image`,
`pages-list`, `page-read`, `page-delete`, `skills-list`, `cadence-list`
(read-only; the Skills page reads it, not `skills-list`), `skill-read`,
`member-console-state`, `open-folder`, `box-version`, `box-rename`. Everything
else is unknown on a local target and `/run` answers 400, the same 400 an org
verb gets everywhere. `/term/open` answers 500 in words.

## The Claude Code hand-off gap (v1)

`claude-settings.mjs` registers boxes in the Claude Code app's `sshConfigs`,
which needs an `sshHost`; there is no equivalent entry for a local folder,
and the Claude Code app's "open folder" is a file dialog this loopback page
cannot drive. v1 therefore hands over a PATH TO COPY: the door's finish
checklist and the Help page show the folder path with a copy button and the
three clicks. It is honest and it works; it is not one click.

## The v1 gap list

- No native folder picker: the door takes a typed path (with `~/` expansion)
  or the default `~/Crads-AI/<slug>`. An occupied folder is refused; an empty
  one or an existing brain is taken.
- No Claude Code one-click open (above). No `startDirectory` registration.
- The Overview's cockpit is a trimmed port: no connector probe, no run
  ledger tail, no Telegram or cadence rows. The Health card reads
  "onboarding"/"active" from the onboarding phase only.
- No skill run from the app (`skill-run` needs the kernel). Skills run in
  Claude Code on the folder, which is the point of this mode.
- No skill removal from the app (`skill-remove` re-syncs against the engine
  set on a box; here removing means deleting the folder by hand or asking the
  assistant).
- `pages-list` seeds the appshell templates on every read, as the box does;
  a member-authored page is never touched (tombstones honoured).
- GitHub backup pushes when the app opens (`pushLocalBrains`, best-effort)
  and on connect; there is no nightly job because there is no night here.
- Moving a folder to a server later is not built: the folder is a plain git
  repo, so the honest path today is "back it up to GitHub, then clone it on
  the box", by hand.
- The dev harness fakes the scaffold (`/local/create` answers a ready folder,
  nothing is made on disk), so the harness shots prove the pages, not the
  filesystem; the filesystem is proven by `local-scaffold.test.mjs` and
  `local-face.test.mjs` against real temp folders.
- Windows: `cmd.exe` is chosen and tested by `shellFor`, and every verb that
  matters is in-process, but nothing here has been RUN on a Windows machine
  yet. That is the first live check to do.

## Files

`wizard/panel/local-targets.mjs`, `local-bridge.mjs`, `local-verbs.mjs`,
`local-scaffold.mjs`, `local-routes.mjs`, `own-brain-local.mjs`,
`engine/lib/local-claude-md.md`, and their `*.test.mjs`; `local-face.test.mjs`
drives the real servers. The seam edits: `ssh-bridge.mjs` (`matchesKind`
admits `local`, `lineWire` exported), `panel-server.mjs` (the table follows
the target's kind), `door-server.mjs` (probe, forget, `/local/*`, the
own-brain dispatch), `last-used.mjs`, `inventory.mjs`, `app.mjs` (one
composed bridge), `member.html`, `door.html`, `wizard-app.yml`.
