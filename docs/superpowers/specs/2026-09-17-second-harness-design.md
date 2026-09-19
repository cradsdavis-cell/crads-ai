# A second harness: run a mineral on OpenCode, any provider, any model endpoint

**Date:** 2026-09-17 · **Rulings by Sam** (question session, same day) · **Status:** RATIFIED by Sam 2026-09-17 ("Ok go"). Partly built the same day, see "Build state" below. OpenCode has NOT been run against a real binary yet.
**Supersedes nothing.** Claude Code stays the default harness and the best-supported path. This spec adds a second one beside it.
**Evidence base:** a file-by-file audit of every Claude touchpoint (67 of them, summarised in §2) and a dated web research pass (§9). Anything not verified first-hand is marked UNVERIFIED and listed in §10.

## Build state (2026-09-17)

| Piece | State |
|---|---|
| P0 adapter extraction, registry, neutral grants (`engine/kernel/lib/harness/`) | built, merged. argv byte-identity pinned by `claude-code.test.mjs`. The duplicated spawn helper is gone. |
| Conformance suite (`tests/harness-conformance.test.mjs`) | built. Offline tier green for both harnesses. **Live tier green on claude-code** (real turns, this date): the control skill job made the symlink and called the mailer; the message turn did neither. |
| OpenCode adapter (policy compiler, isolation, connection derivation, output parse) | built from OpenCode's docs, pinned by fixtures. **Never run live.** Not offered anywhere. |
| OpenCode adapter vs the REAL binary (1.18.31, no model behind it) | verified 2026-09-17: the generated config passes its strict validation (permission policy, `mailer_*` key, local MCP shape, custom endpoint provider all accepted); `.claude/skills/<n>/SKILL.md` is discovered in place; every data, config, state and cache path resolves inside `<state>/.opencode-auth` and nothing appears in `$HOME`; an endpoint is dialled at `<base_url>/chat/completions`; failure = exit 1, empty stderr, one error event on stdout (now surfaced). NOT verified: a successful turn, the text event shape, whether the policy is honoured. Those need a model. |
| `assistant:` profile block, credential paths in never-commit + backup lists | built. The dead `models:` block is deleted. |
| Box-side state, writer and probe (`engine/lib/assistant-state.mjs`, `engine/ops/assistant-set.mjs`, `engine/ops/assistant-probe.mjs`) | built, merged. One reader answers "what does this mineral think with, and is it ready"; the cockpit row, the setup probe and the heartbeat all read it. The writer validates against the registry and refuses in words; a key goes to `secrets/` at 0600 over STDIN, never argv, never the profile. The probe runs from the mineral and passes only on a well-formed tool call; tested against a real local HTTP server in seven modes. |
| Panel and wizard (§5.1, §5.2) | built, merged, **hidden**. Overview rung and the wizard's finish row re-word themselves per harness; "What your mineral thinks with" card on the Your mineral page with the where-your-words-go line; verbs `assistant-set` and `assistant-probe`. Driven in a real browser across four mineral states, zero console errors; all `qa-*` files green serially. |
| Image bake and plugin ports (P3) | built and **proven by CI** (publish-image run 35192145959, 2026-09-17): all three images built for amd64 and arm64 and were pushed. The build cannot pass unless one skill from each plugin is discoverable, and the boot-smoke requires the binary and the template. No image was built locally (3 GB free on this box). The first attempt ran the hosted runner out of disk mid-export; fixed by dropping a redundant 100 MB global install, clearing the npm cache in-layer and freeing unused toolchains on the runner. `Dockerfile.base` pins OpenCode 1.18.31, GSD Core 1.14.0, superpowers v6.3.0 and skill-creator at a commit, bakes them at `/state/.opencode-auth` and moves them to `/opt/opencode-template`; the build FAILS unless one skill from each of the three plugins is discoverable. `engine/box/opencode-seed.sh` seeds a mineral (one script for pebble and rock). Every step was dry-run against the real binary in scratch space first: 87 skills discovered, superpowers and 72 GSD ones included. Adds roughly 270 MB to the base image; `--build-arg OPENCODE_VERSION=` leaves it out. |
| Matrix (P5) | not started: needs an account and inference hardware. |

**What the plugin port found, on the real binary (2026-09-17). Read this before touching `isolationEnv`.**
- GSD Core's OpenCode install writes its OWN `permission` rules and an always-on MCP server into the global `opencode.json`. The server is `npx -y -p @opengsd/gsd-core gsd-mcp-server`: unpinned, fetched from the network each time. The bake re-points it at the pinned global install.
- OpenCode MERGES every config layer, and a merged permission object keeps each key at the position of the layer that FIRST defined it. With "last match wins", our catch-all deny then sits AFTER GSD's `read` rule and refuses every read, and GSD's MCP server appeared inside a conversational turn. It failed closed, but it broke the turn and it broke "an ungranted connection is never configured".
- Fix, verified against a hostile project `opencode.json` plus GSD's global config: an unattended turn reads exactly one config. `XDG_CONFIG_HOME` points at `.opencode-auth/headless` (engine-owned, never seeded) and `OPENCODE_DISABLE_PROJECT_CONFIG=1`. Result on the real binary: `mcp: {}`, catch-all first, shell denied, project skills still discovered.
- **Consequence, a real gap against ruling 6:** on OpenCode the three plugins exist at the TERMINAL only. Scheduled jobs and Telegram turns do not load them. On Claude Code they do. The shipped skills do not use them, so nothing shipped breaks, but a member-written skill that leans on a superpowers skill would work from the terminal and not from cadence. The matrix must carry that row.
- The policy now also denies WRITES to the files that configure a later turn (`opencode.json`, `.opencode/`, both auth dirs, `.claude/settings*`, `.mcp.json`, `secrets/`, `.kernel/`). Checked the same attack live on Claude Code: it refuses to write its own settings file, and a pre-placed permissive settings file did not give a conversational turn a shell in an untrusted scratch folder. NOT checked: a folder the member has already trusted interactively, which is what a real mineral is.
- GSD bakes its absolute install path into about 330 files, so the bake runs at the real path and the seed script rewrites it for a mineral mounted elsewhere.
- Still UNVERIFIED: that `OPENCODE_DISABLE_PROJECT_CONFIG` leaves `CLAUDE.md` loading as instructions (skills survive it; rules were not observable without a model).

**How a tester reveals it.** On the mineral: `touch /state/.kernel/experimental-harness` (or name a non-Claude harness in the profile). Or in the app: open the mineral with `&thinks=1` in the URL. In the wizard window: `localStorage['crads.experimental-harness']='1'` shows a link on the finish screen. None of these bypass anything: the mineral's writer still validates, and an older image refuses in words.

**Where the build departed from this spec, and why.**
- §5.1 put the choice BEFORE sign-in as a provisioning step. Built instead as a card on the live mineral plus a link from the wizard's finish screen: the profile only exists once the mineral is born, a mineral is born thinking with Claude, and the same card then serves a mineral made last month. One writer, one place.
- §5.1's probe checked the context window. Dropped: there is no portable way to ask an OpenAI-compatible server for it, and a guessed number is worse than none. The card states the hardware floor in words instead.
- §5.2 said the Claude Code desktop-app registration (`claude-settings.mjs`) would be skipped on a non-Claude mineral. Left on: it only adds an SSH entry to the member's own Claude Code app, which still works against any mineral on the laptop's own account, and it is decided at connect time, before the harness is known.
- The terminal exports OpenCode's isolated paths through a shell FUNCTION wrapping `opencode`, not shell-wide `XDG_*` exports, which would have moved every other tool's config too.
- The cockpit's data key is `thinks_with`, because `assistant` was already the assistant's name.
- The sign-in command typed into a terminal is never taken from the mineral. The app and the setup probe each pick it from their own fixed list, and a hostile-mineral test pins that.

Lesson from the first live run, kept in the test's header: the shell canary must be a symlink. Denied a shell, the message turn made an empty file with its Write tool, which it may do, and a plain-file canary read that as a breach.

## 1. The rulings

Sam ruled these on 2026-09-17. Everything below is those sentences made mechanical.

1. **Why.** Three drivers, all live: private inference (a member's words never leave hardware they control), a vendor-risk hedge (the product must survive Anthropic changing terms, price or the CLI), and wider adoption (people who already pay for another assistant can use it). OSS purity was offered as a driver and NOT picked.
2. **Harness stance.** Add OpenCode as a second harness behind an adapter. Claude Code stays the default and keeps its plugins and its desktop-app integration. Rejected: swapping Claude Code's backend with `ANTHROPIC_BASE_URL` (§8), and making OpenCode the default.
3. **Where a model may live.** An endpoint URL, anywhere. Same machine, a home GPU box over a private network, a rented GPU server. One mechanism. The wizard and docs state the hardware reality for each.
4. **Spend rule for members.** No per-token billing. Free, flat-fee and sign-in entitlements pass. Metered keys are not a first-class option.
5. **Quality bar.** A tested matrix with honest labels (§6). Local models ship labelled experimental.
6. **Plugins are load-bearing.** A harness without superpowers, gsd and skill-creator equivalents is not full functionality (§4.4).
7. **The harness set is open** (added the same day, second pass). OpenCode is the first non-Claude harness, not the only one. Any harness that implements the adapter contract and passes the conformance suite can be registered (§3.3). Local open-weight models are NOT a harness: they are a model source, reached through the endpoint URL by whichever harness is in use.
8. **Order of work.** Spec first. No spike yet: there is no second account and no confirmed inference hardware to test against (§7, prerequisites).

"The 4 Cs" is the functional contract: Context, Connections, Capabilities, Cadence must all work on the second harness.

## 2. What is coupled today (the audit)

The model is called from exactly two places, both a bare `spawn('claude', ...)`:
`engine/kernel/lib/runner.mjs` (`runClaude`) and a hand-duplicated copy in `engine/lib/org-publish.mjs`
whose own comment says "keep both tiny and in sync". There is no provider or model knob anywhere.
The `models:` block in `config/profile.schema.yaml` is dead config: nothing reads it.

Everything around those two call sites speaks Claude Code's dialect. Three grades:

| Grade | Meaning | Examples |
|---|---|---|
| **A, thin** | a binary name and flags | the two spawns, `entrypoint.sh` verbs, `command -v claude` smoke |
| **B, format** | Claude Code file conventions other harnesses may read | `CLAUDE.md`, `.claude/skills/<n>/SKILL.md` (eight independent readers, some inside SSH one-liners in `panel-server.mjs`), `.mcp.json`, the brain-ignore floor naming `.claude-auth/` |
| **C, deep** | Claude Code behaviour with no generic equivalent | `--permission-mode acceptEdits` plus the `--allowedTools` string (this IS the D4 default-deny-outbound enforcement); the `mcp__<server>__*` allow grammar; the per-project MCP approval gate hand-written into `.claude.json` (`mcp-connect.mjs`); `claude mcp list` stdout scraping (`box-cockpit.mjs`); the plugin marketplace bake and `settings.json` merge (`Dockerfile.base`, `box-up.sh`, `boot-rock.sh`); the subscription credential file and its measured expiry quirks (`claude-credential.mjs`); sign-in as "run `claude` in the Terminal tab" (`SIGNIN_OPENER`); the app writing the member's own `~/.claude/settings.json` (`claude-settings.mjs`); the SFTP subsystem installed solely for the Claude Code desktop app |

By C: Context is grade B throughout and portable. Connections is B with three C items. Capabilities is B plus the plugin bake (C). Cadence is A except that its rate floors are shaped by Claude subscription quota (`cadence-lib.mjs` `EVERY_FLOOR_MIN`, the inbox-watcher default in `scheduler.mjs`).

One precedent already exists for a pluggable provider: `engine/voice/serve-voice.mjs` takes `VOICE_TTS_URL`. And one Claude dependency was already replaced on purpose: the app's own MCP OAuth (`mcp-oauth-lib.mjs`) exists to stop driving `claude mcp login`.

## 3. The shape

Two new ideas, kept separate because they vary independently:

- **Harness**: the agent program that runs a turn. `claude-code` (default) or `opencode`.
- **Model source**: where the thinking happens. A sign-in entitlement or an endpoint URL.

```yaml
# profile.yaml  (replaces the dead `models:` block)
assistant:
  harness: claude-code          # any id in the harness registry (§3.3); ships with claude-code, opencode
  model:
    source: signin              # signin | endpoint
    provider: anthropic         # anthropic | openai | github-copilot | ollama | openai-compatible
    id: ""                      # harness default when empty; required for endpoint
    base_url: ""                # endpoint only
    key_ref: ""                 # SECRET REF into /state/secrets; never the key itself
    context_tokens: 0           # endpoint only; probed, then pinned
    timeout_s: 240              # per turn; raise for slow hardware
```

`harness: claude-code` only ever pairs with `provider: anthropic, source: signin`. That is ruling 2: the backend swap is not offered. Every other combination runs on a non-Claude harness, `opencode` first. Each harness declares which providers and sources it can serve (§3.3), and the profile validator refuses a pairing the harness does not declare.

### 3.1 The adapter

New directory `engine/kernel/lib/harness/` with `index.mjs`, `claude-code.mjs`, `opencode.mjs`. `runner.mjs` and `org-publish.mjs` both import it, which also deletes the duplicated spawn helper.

The contract is expressed in capabilities, never in one harness's tool names:

```js
run({ stateDir, prompt, grants, addDirs, timeoutMs }) -> { text }
//  grants = { files: true, shell: bool, skills: bool, mcp: ['google_workspace', ...] }
signedIn(stateDir)        -> { ok, account|null, detail }
installSkills(stateDir)   -> void        // today's syncSkills, harness-aware
syncConnections(stateDir) -> void        // derive harness config from .mcp.json
probeConnections(stateDir)-> [{ name, state }]
isolationEnv(stateDir)    -> { ...env }  // the CLAUDE_CONFIG_DIR rule, generalised
```

`grants` is the security-critical part. Today D4 (default-deny outbound) is enforced by which names appear in one comma string. The adapter makes it a data structure that each harness compiles:

| Job | grants | Claude Code compiles to | OpenCode compiles to |
|---|---|---|---|
| skill job | files, shell, skills, mcp: derived from `.mcp.json` + `.kernel/mcp-allow` | `--permission-mode acceptEdits --allowedTools Skill,Bash,Read,Edit,Write,Glob,Grep,mcp__x__*` | `OPENCODE_PERMISSION` JSON: `"*":"deny"`, then `allow` for read, edit, write, glob, grep, skill, bash and each granted server's tools |
| `message` job (Telegram, voice) | files, skills. No shell, no mcp | same string minus `Bash` and every `mcp__` | same JSON with bash and all MCP tools left at `deny` |
| org-publish | files only, plus `addDirs` | `Read,Edit,Write,Glob,Grep --add-dir` | files allow, everything else deny; extra dir via OpenCode's external-directory permission (UNVERIFIED key name) |

Rules for the OpenCode policy compiler:

- It never emits `ask`. What `ask` does in `opencode run` is undocumented, so the policy is total: every tool is `allow` or `deny`. `--auto` is therefore not used.
- The base is `"*":"deny"`. A tool the compiler has never heard of is denied. A new OpenCode release that adds a send-capable built-in tool fails closed.
- OpenCode's MCP tool naming is believed to be `<server>_<tool>` (UNVERIFIED). The compiler's pattern grammar is pinned by a test against the pinned OpenCode version, the same way `mcp-allow.test.mjs` pins Claude's.
- A negative test lands with the adapter: a `message` job, on each harness, is handed a prompt that tries a shell command and an MCP send, and the test asserts neither ran. This is the test that makes the second harness safe to ship; without it the feature does not merge.

### 3.2 Isolation (the identity-leak rule, generalised)

`runner.mjs` pins `CLAUDE_CONFIG_DIR` so a headless turn can never pick up the operator's account from `$HOME`. OpenCode has the same hazard in three places, all closed by `isolationEnv`:

- credentials live at `~/.local/share/opencode/auth.json` → set `XDG_DATA_HOME=<state>/.opencode-auth/data`
- global config and global `AGENTS.md` at `~/.config/opencode/` → set `XDG_CONFIG_HOME=<state>/.opencode-auth/config`
- it reads `~/.claude/CLAUDE.md` for compatibility → set `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` (project-level `.claude/skills` and `CLAUDE.md` stay readable, which is what we want)

`.opencode-auth/` joins the REQUIRED block of `engine/lib/brain-ignore.txt` (it is credential-shaped) and the `backup.targets` list in `engine/policy.json`. Note the brain-ignore header's warning: widening the required block turns off nightly push on boxes whose ignore file predates it, so the same commit must extend the repair path that rewrites old ignore files.

### 3.3 The contract is open: a harness registry and a conformance suite

Ruling 7. The adapter in 3.1 is written as a public contract, not as a two-way switch.

**Registry.** `engine/kernel/lib/harness/registry.json` lists harness ids. Each id maps to one module exporting the six functions of 3.1 plus a static manifest:

```js
export const manifest = {
  id: 'opencode',
  bin: 'opencode', version: '<pinned>',
  serves: [ { provider: 'openai', source: 'signin' },
            { provider: 'github-copilot', source: 'signin' },
            { provider: 'ollama', source: 'endpoint' },
            { provider: 'openai-compatible', source: 'endpoint' } ],
  reads: { contextFile: 'CLAUDE.md', skillsDir: '.claude/skills' },   // what it discovers in place
  signinCommand: 'opencode auth login',                               // null when it has none
  credentialPaths: ['.opencode-auth/'],                               // feeds brain-ignore + backup targets
};
```

`reads` matters because the product's files do not move. A harness that cannot discover `CLAUDE.md` and `.claude/skills/<n>/SKILL.md` in place gets them through its adapter (`installSkills` may symlink or copy into the harness's own directory; the context file may be passed as an explicit instructions path). The source of truth stays where the eight existing readers expect it. `credentialPaths` is how a new harness's secrets reach the never-commit floor and the backup set without anyone hand-editing two more lists.

**Conformance suite.** `tests/harness-conformance.test.mjs` runs the same fixture-driven checks against every registered harness. A harness is registrable only when all pass:

1. **Deny by default.** Its `grants` compiler produces a total policy. A tool the compiler has never heard of is denied. A harness whose permission model cannot express deny-by-default for unattended runs is refused outright, however good it is otherwise. This is the one non-negotiable: it is the D4 rule.
2. **The negative test.** A `message` job that is prompted to run a shell command and to call a send-capable MCP tool does neither.
3. **Isolation.** With a decoy credential and a decoy global instructions file planted in `$HOME`, a run under `isolationEnv` reads neither.
4. **Headless contract.** Closed stdin, hard timeout honoured, non-zero exit on failure, final text extractable.
5. **Connections.** A server present in `.mcp.json` is callable by a skill job and not by a `message` job.
6. **Skills.** A seeded SKILL.md is discovered and loadable by name.

Passing conformance earns the label **registrable**, nothing more. **Supported** still comes only from the matrix (§6), per harness and per model.

**Candidates beyond OpenCode**, from the research pass, in rough order of fit: Codex CLI (Apache-2.0; sandbox plus exec-policy rules; first-party ChatGPT sign-in; `--oss` for local endpoints), Goose (Apache-2.0; `GOOSE_MODE`; recipes; many providers), Cline CLI, Qwen Code, pi (no built-in MCP, so its adapter would have to carry an extension and prove check 5). Aider fails Connections and Capabilities and is not a candidate. Closed-source harnesses (Copilot CLI, Antigravity CLI) can technically be adapted but cannot serve local endpoints. None of these is promised by this spec; the contract just stops the door being welded shut.

**Who writes them.** The project ships and maintains two: `claude-code` and `opencode`. Others are community contributions against the contract, accepted when conformance is green in CI, and listed in the wizard only once they have a matrix column. Support scope in the paid offer follows the same line: the two first-party harnesses, not the long tail.

**What this costs.** P0 already extracts the adapter; making it a registry with a manifest is a small addition there. The conformance suite is new work in P1, but it is the same negative and isolation tests OpenCode needed anyway, written once against fixtures instead of once per harness. The wizard, panel and heartbeat in §5 read the manifest (sign-in command, credential paths, marks) instead of branching on two names.

## 4. The 4 Cs on the second harness

### 4.1 Context

No file moves. OpenCode reads a project `CLAUDE.md` when no `AGENTS.md` is present (verified, OpenCode rules docs). Two consequences:

- **Never ship an `AGENTS.md` next to `CLAUDE.md`.** `AGENTS.md` wins outright, so one stray file silently replaces the whole assistant contract and the org-context block that `org-brain-setup.sh` appends. A test asserts no template, seed or scaffold path writes one.
- The body of `CLAUDE.md` and `engine/lib/local-claude-md.md` name "Claude Code" and "run `/onboard` in Claude Code". Copy pass: say "your assistant" where the harness is not the point. Templates gain no per-harness variants; three CLAUDE.md variants are already enough.

The wiki, `profile.yaml`, `onboarding-state.json` and STATE.md carry no coupling beyond STATE.md's one line labelling a connection tier, handled in 4.2.

### 4.2 Connections

`.mcp.json` stays the single source of truth. `syncConnections` for OpenCode derives the `mcp` block from it at spawn time and passes it inline through `OPENCODE_CONFIG_CONTENT`. No second file means nothing to drift and nothing new holding secrets on disk. For interactive use in the Terminal tab the same derived config is exported into the shell's environment by the SSH bridge, exactly where `CLAUDE_CONFIG_DIR` is exported today.

- Server object mapping (`type/command/args/env` to OpenCode's `type/command/enabled/environment`) is pinned by test. OpenCode's exact local-server shape is UNVERIFIED between `"stdio"` and `"local"`.
- **The three-tier Connections page collapses to two on OpenCode.** "Connected to your Claude account, chats only" exists because claude.ai connectors live on Anthropic's servers. On OpenCode that tier is not rendered.
- The per-project approval flag written into `.claude.json` is Claude-only. OpenCode's equivalent is `enabled: true` in the derived config.
- `probeConnections` replaces the `claude mcp list` scrape. For OpenCode, prefer the app's own OAuth token state (already harness-free) plus a cheap MCP `initialize` handshake over scraping another CLI's human output.
- `engine/skills/connect.md` says "Never use `claude mcp add`". Generalise to "never add a connection from inside the assistant; use the Connections page", which is true on both.

### 4.3 Capabilities: the shipped skills

Skills stay at `.claude/skills/<name>/SKILL.md`. OpenCode discovers that path natively and ignores unknown frontmatter keys (verified), so the Crads extensions (`title`, `category`, `generic`, `reads*`, `writes`) are safe. All eight readers keep working untouched.

One change: the runner's prompt says "Run the /<skill> skill". Slash resolution is a Claude Code convention. New wording names the skill and tells the assistant to load it with its skill tool, which both harnesses have.

### 4.4 Capabilities: the plugins (ruling 6)

| Plugin baked today | Path on OpenCode | Confidence |
|---|---|---|
| superpowers (`obra/superpowers`) | upstream documents an OpenCode install | verified that it is documented; NOT verified that hooks-dependent behaviour matches |
| gsd (`jnuyens/gsd-plugin`) | the baked fork is Claude Code native (82 commands, 33 agents, hooks, an MCP server; its README now calls itself Buildomator). The upstream line continues as GSD Core (`open-gsd/gsd-core`, MIT), whose installer lists OpenCode as a runtime | verified that both statements are documented; the two are NOT the same artefact, so parity is a test question |
| skill-creator (`anthropics/claude-plugins-official`) | a plain skill. Ship it as a SKILL.md in the skills seed. Licence check required before copying it into an AGPL repo | UNVERIFIED licence |

Bake mechanism: `/opt/opencode-template` beside `/opt/claude-plugins-template`, seeded into `<state>/.opencode-auth/config` by the same idempotent step in `box-up.sh` and `boot-rock.sh`. OpenCode is pinned by `ARG OPENCODE_VERSION` for the same reason the Claude CLI is pinned.

Honest expectation: the skills inside these plugins port cleanly. Their hooks (session start, post-compaction) and slash commands will not all have equivalents. The matrix (§6) carries explicit plugin rows so the gap is published, and ruling 6 means a row that fails blocks the "supported" label for that harness, not the release of the feature as experimental.

### 4.5 Cadence

The scheduler, queue, kernel and outbox are harness-free already. Changes:

- **Rate floors become per-source.** `EVERY_FLOOR_MIN = 30` and the inbox-watcher default-off exist because a frequent `claude -p` exhausts a member's plan. A local endpoint has no quota, but it has one GPU. For `source: endpoint` the floor drops and a concurrency of 1 is enforced by the kernel instead, so a slow model queues rather than thrashes.
- **Timeouts.** 240 s is a hosted-model number. `assistant.model.timeout_s` overrides it. A CPU-only endpoint processing a long prompt can take minutes per turn (estimate, not measured).
- **Output.** OpenCode runs with `--format json`; the adapter extracts the final assistant text. The `PROPOSE-SEND:` line contract and the 4000-char outbox cap are unchanged, so `telegram.mjs` and the voice bridge need no edits.

## 5. Surfaces

### 5.1 The wizard: "What should your mineral think with?"

One new step, after the server exists and before sign-in. Four choices, costs stated up front like the existing costs screen:

1. **Claude subscription** (default, recommended, fully supported). Today's flow, unchanged.
2. **ChatGPT subscription.** OpenCode sign-in. Label: works today, depends on OpenAI continuing to allow it.
3. **GitHub Copilot.** OpenCode sign-in. Label: the free plan's monthly agent allowance will not cover daily cadence.
4. **A model endpoint.** URL, model id, optional key. Label: experimental. Shows the hardware table from §9 in plain words.

There is no "paste an API key for a metered provider" card (ruling 4). The endpoint form accepts a key because flat-fee plans and private servers need one; the docs say plainly that pointing it at a metered service is the member's bill. We cannot detect it and will not pretend to.

**The endpoint probe runs before anything is saved**, from the box, and refuses with a plain sentence on failure:
reachable; model id exists; one forced tool-call round trip returns a well-formed call (catches models and servers that drop tool calls, the most reported local failure); context window at least 32K. The probed context is pinned into the profile.

### 5.2 The panel

- `setup-steps.mjs` returns `assistant: { harness, signedIn, account, detail }` and keeps `claude: {signedIn}` as an alias for one release so an older app does not break (the exe and the images ship independently).
- `SIGNIN_OPENER` becomes per-harness: `claude`, or `opencode auth login`. An endpoint source has no sign-in rung; its rung is "endpoint reachable", backed by the probe.
- `claude-settings.mjs` (writes the member's `~/.claude/settings.json` so the mineral appears in the Claude Code desktop app) runs only when the harness is `claude-code`. On OpenCode the way in is the Crads-AI app's Terminal tab. The SFTP subsystem stays in the image; it is harmless.
- The Help page "Claude Code on your mineral" gains a sibling, not a rewrite.
- **"Where your words go"**: one line on Overview, derived from the profile. Example for a local endpoint: "Thinking happens at 100.x.y.z (your machine). Connected services (Google, GitHub backup) still see what you send them." This is the honest answer to the private-inference driver and it must not overclaim: see the egress item in §10.

### 5.3 Fleet and secrets vocabulary

`claude_credential_present` (heartbeat), the vault row "Claude sign-in", and `box-account.mjs`'s identity guard all generalise to "assistant credential", with the old heartbeat field kept as an alias. The Claude brand mark stays; marks for the other sign-ins are added to `vendor/marks`.

### 5.4 Images and the local face

- `Dockerfile.base` gains pinned OpenCode and the template bake. Image growth to be measured.
- **No model server in the image.** An endpoint is external by ruling 3. For "same box" on a large server, the docs give a compose sidecar recipe. A cx33-class mineral cannot serve a useful model and the wizard says so.
- The local face ("On this computer") uses whatever harness is installed on that computer. `local-routes.mjs` already answers `claude: null` there; it gains the same `assistant` shape. This is the natural home of the private-inference case: notes, harness and model all on one machine.

## 6. The matrix (ruling 5)

Published as a docs page and regenerated per release. A cell is three runs; pass criteria are structural (the files the skill defines were changed, the MCP call happened, the outbox line is well-formed), never string matches (trap 6).

**Rows:** the 11 engine skills (capture, connect, daily, dashboard, explain, followup, inbox, onboard, plan-week, weekly, write-page); starter skills eod and pulse; a `message` turn; a `PROPOSE-SEND` draft; the D4 negative test; org-publish; one scheduled cadence run end to end; one read through a real MCP connection; plugin rows (a superpowers skill, a gsd flow, skill-creator).

**Columns:** Claude Code + Claude (the baseline every other column is judged against); OpenCode + ChatGPT sign-in; OpenCode + Copilot; OpenCode + endpoint with Qwen3.6-27B; OpenCode + endpoint with gpt-oss-20b.

**Labels:** supported (3 of 3 on every row) · works with caveats (named rows flaky) · experimental (runs, several rows unreliable) · not supported. Local-model columns are capped at experimental for the first release whatever they score.

## 7. Build order and prerequisites

Each phase merges to `hardening-loop` on its own and is safe to ship alone.

| Phase | What | Member-visible |
|---|---|---|
| **P0** | Adapter extraction as a registry plus manifest (§3.3), with Claude Code as the only registered harness. `grants` replaces the allowlist string. Duplicate spawn in `org-publish.mjs` deleted. Byte-identical CLI args asserted by test. | nothing |
| **P1** | The conformance suite (§3.3), then the OpenCode adapter built to pass it: policy compiler, isolation env, connection derivation, JSON output parse. Dry-run and fixture tests only. | nothing |
| **P2** | `assistant:` profile block, setup-steps shape, panel sign-in rung, brain-ignore and backup targets, heartbeat alias. | nothing until a profile opts in |
| **P3** | Image: pinned OpenCode, template bake, plugin ports. | nothing until promoted |
| **P4** | Wizard step, endpoint probe, "Where your words go", docs pages. | yes |
| **P5** | Matrix run on real accounts and real hardware; publish; then and only then flip the wizard cards from hidden to visible. | yes |

**Prerequisites that block P5 (and make a spike pointless before them):** a ChatGPT or Copilot account to test against (Sam holds neither today); inference hardware for the endpoint column (32 GB+ Apple Silicon or a 24 GB GPU; the Oracle box is CPU-only and would only yield the slow-VM data point); a decision on who pays for them. P0 to P3 need none of these.

## 8. Rejected

- **Claude Code with `ANTHROPIC_BASE_URL` pointed at another model.** Cheapest by far, and common in the wild. Rejected by ruling 2 because Anthropic documents it as unsupported, the binary is proprietary and has been enforced against third parties this year, prompt caching is lost (every turn re-processes the full system prompt, which is the dominant cost on local hardware), and `tool_choice` and token counting degrade. It does not serve the vendor-risk driver at all, since the harness is the vendor.
- **OpenCode as the default.** Would rewrite the sign-in, Connections and image story for every member to serve a minority, and drops the Claude Code desktop-app integration members use today.
- **Codex CLI or Goose as the FIRST non-Claude harness.** Both cover the 4 Cs and both stay open as later registrations (§3.3). OpenCode goes first on reading `.claude/skills` and `CLAUDE.md` in place (zero file moves), on carrying both the ChatGPT and Copilot sign-ins, and on an env-inlined permission policy that maps onto `grants`.
- **A model server baked into the image.** Ruling 3 makes the endpoint external.

## 9. Research snapshot (2026-09-17; re-verify before building)

- Subscription sign-in outside the vendor's own tool: Anthropic closed it (Jan to Apr 2026, Claude Code only). OpenAI allows ChatGPT sign-in in Codex and currently in OpenCode. GitHub allows Copilot sign-in in OpenCode. Google moved its free terminal tier to a closed binary in June 2026.
- Agent Skills (SKILL.md) is a cross-vendor format with roughly 40 adopters including OpenCode, Codex, Goose and Copilot CLI.
- Local reality: best runnable open-weight model for agent loops is Qwen3.6-27B (about 17 GB at 4-bit); gpt-oss-20b is the stable small choice. Hardware floor for this product's loop is 32 GB+ Apple Silicon or a single 24 GB GPU. 16 GB is marginal. An 8 GB CPU-only server is not viable. A large CPU-only server can run a sparse model slowly (estimate, unmeasured). Every field report names the same failure: dropped or malformed tool calls on long loops.
- Hetzner Cloud has no GPU instances.

## 10. Unverified, and what would verify it

1. ~~OpenCode's MCP tool naming and local-server key.~~ Settled from its docs 2026-09-17: tools register as `<server>_<tool>`; a local server is `type: "local"` with `command` as an array and `environment`. Still open: whether the PERMISSION matcher keys on that tool name. The adapter does not depend on it (an ungranted server is never configured), and the live conformance run will show it.
2. What `ask` does under `opencode run`. Moot if the policy stays total, but confirm `"*":"deny"` is honoured for built-in and MCP tools alike. This is the D4 test in P1.
3. The external-directory permission key org-publish needs.
4. **OpenCode's own network egress** (model catalogue fetch, update check, share feature, telemetry). The private-inference claim in 5.2 is only true if these are off or absent. Verify by packet capture on a box with a local endpoint before any copy says "nothing leaves your machine". Until then the copy says where thinking happens and stops there.
5. Plugin parity on OpenCode (hooks, commands), and skill-creator's licence.
6. How durable OpenAI's and GitHub's tolerance of third-party sign-in is. Not verifiable; the wizard label says so.
7. CPU-only throughput numbers. Measure before the docs quote any.

## 11. Risks

- **The policy compiler is the whole security story of the second harness.** A mapping bug is an assistant that can send mail unattended. Hence the fail-closed base, the negative test as a merge gate, and OpenCode pinned by version.
- **Two harnesses double the QA surface** for a one-person project whose income is support hours. The matrix is the control: what is not green is not called supported, and support scope in the offer follows the labels.
- **OpenCode moves fast.** Pin, and treat a bump like a Claude CLI bump: re-run the matrix.
- **Quality expectations.** A member on a local model gets a slower, less reliable assistant. The wizard, the label and the matrix must say so before they choose, not after.
