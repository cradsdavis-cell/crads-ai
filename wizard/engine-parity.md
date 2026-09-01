# engine.mjs parity checklist

Maps every step of the bash pair (`wizard/aios-setup.sh` + `provisioning/rock/provision-rock.sh`, helpers from `provisioning/managed/lib.sh`, teardown from `provisioning/rock/deprovision-rock.sh`) to its JS equivalent in `wizard/engine.mjs`, and states what a parity test must compare. Divergences are intentional and listed at the bottom (also in the engine.mjs header).

## Step map: wizard (aios-setup.sh -> runWizard)

| Bash step | JS equivalent | Parity check |
|---|---|---|
| `ask` prompts via `AIOS_SETUP_*` env | `answers` object (bare or `AIOS_SETUP_`-prefixed keys), `process.env.AIOS_SETUP_*` fallback | missing no-default field throws the same "no terminal and no $AIOS_SETUP_X set" message |
| ORG_NAME slug gate `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` | `ORG_SLUG_RE`, same regex | same die message |
| Brain-repo auto-name: `GET /user`, `git@github.com:<login>/<org>-brain.git` | same call, same URL shape (stays SSH form: cloud-init clones with the deploy key) | error text incl. HTTP code (000 on network fail) |
| Token pings: Hetzner `/locations`, CF `zones?name=`, zone-name grep | same calls; zone check is `result[].name === DOMAIN` | same three ok/die messages |
| Repo exists check `GET /repos/<rp>` | same | same |
| Repo create + template seed (local dir + git push) | **divergence 1**: create via API, seed from `TEMPLATE_REPO` via Git Data API (blobs -> tree -> commit -> `refs/heads/main`, then PATCH default_branch) | commit message `seed: <org> brain (wizard, from template)`, author `<org> setup <setup@local>`, branch `main`, private repo, same description |
| deployment.yaml heredoc | `buildDeploymentYaml()` | **bytes must be identical**, incl. operator-list `tr`/`sed` edge cases (trailing comma drops the segment, interior empties become `  - `, leading whitespace stripped), the trailing space on empty `content_repo: `, and the trailing EXTRA_YAML line |
| `AIOS_IMAGE` default + `AIOS_SETUP_SLUG` default `rock` | same defaults | same |
| D40 operator access key: `ssh-keygen -t ed25519 -C operator-<org>`, pubkey exported as `OPERATOR_PUBKEY`, then on success the `__ACCESS_CONFIG_BEGIN/END__` Host block + `__ACCESS_KEY_BEGIN/END__` private key | `generateDeployKeypair('operator-<org>')` in `runWizard` (added D41 phase 2), `operatorPubkey` passed into `provisionRock` -> `renderCloudInit`, same marker lines emitted line-for-line after the provision returns | pubkey line matches `ssh-keygen -y` on the private half; marker block layout identical (Host / HostName / User / IdentityFile); key streams to the operator only (server log redacts between the key markers) |

## Step map: provisioner (provision-rock.sh -> provisionRock)

| Bash step | JS equivalent | Parity check |
|---|---|---|
| `valid_slug` (lib.sh) | `VALID_SLUG_RE`, same regex | same die message |
| `need curl jq python3 ssh-keygen base64` | not needed (all in-process) | n/a |
| `reqenv` token check | same loop, same "missing env var: X" message | same |
| state-exists guard `rock-<slug>.env` | same path under `provisioning/managed/state` (override: `STATE_DIR` answer / `AIOS_STATE_DIR`) | same die message |
| `dget` flat-YAML reader (`grep -oP` + trailing-space strip) | `dget()`, same first-match + `[^"#]*` + rstrip semantics | same values out of the same file |
| `AIOS_IMAGE` `:?` guard + `*ai-os-parent*` case gate | same two die messages | same |
| `cf_resolve_ids` (lib.sh): zone lookup carries `.account.id` | inlined: one `zones?name=` call, `zone[0].id` + `zone[0].account.id` | same die messages |
| deploy key: `ssh-keygen -t ed25519 -N '' -C aios-rock-<slug>` + `POST /repos/<rp>/keys` | **divergence 3**: `generateDeployKeypair()` in node:crypto, same POST (title `aios-rock-<slug> (read-only)`, `read_only:true`, pubkey incl. trailing `\n` exactly as jq `--rawfile` sent it) | `ssh-keygen -y -f` must derive the identical public line from our private key |
| `cleanup_partial` trap | `rollback()` in the catch path: server, DNS record, tunnel connections, tunnel, deploy key, in that order, best-effort, skipped once the state file exists | same ordering; JS guards every id (divergence 5) |
| `PASSWORD` = 18 urandom bytes, base64, strip `/+=` | `randomBytes(18).toString('base64').replace(/[/+=]/g,'')` | same alphabet + length distribution |
| tunnel create (`config_src: cloudflare`), token fetch, ingress PUT (7781 + 404 fallback), DNS CNAME `<tunnel>.cfargotunnel.com` proxied ttl 1 | same four calls, same `cf_call` success-check + failure text | same request bodies |
| cloud-init render (inline python, replace-all token substitution incl. key-block indent and b64 blocks) | `renderCloudInit()` (split/join so `$` in values is never a pattern) | **bytes must be identical** given the same key, deployment.yaml, and token values; both SSH_RULE branches |
| `__OPERATOR_PUBKEY__` substitution: python `e.get('OPERATOR_PUBKEY', 'ssh-ed25519 AAAA-no-operator-key-staged disabled')` | same in `renderCloudInit()` via `v.OPERATOR_PUBKEY ?? <placeholder>` (absent -> placeholder, empty string stays empty, matching `e.get`) | same rendered line for present / empty / absent |
| 31000-byte cap check | same, same message | same numbers |
| Hetzner create: pin override else candidate walk (lib.sh `HCLOUD_CANDIDATES` default list), `resource_unavailable` / `invalid_input`+"unsupported location" retry, else die | same list, same order, same retry predicate, same die text | same |
| boot wait: 60 x 3s for `running` + non-null IP | same loop, proceeds regardless after 60 tries (bash behaviour) | same |
| state file write | `serializeState()` | **same 13 keys, same order, same `KEY="value"` format**, `BRAIN_REPO` = owner/name path |
| online wait: 90 x 8s for 200/302 via `url_status` (plain probe then DoH + resolve fallback) | `urlStatus()`: fetch with `redirect:'manual'` (curl does not follow redirects), then 1.1.1.1 DoH + node:https SNI dial (divergence 7) | 302 must count as up |
| final summary (URL, password, teardown ids) | same lines | password surfaced exactly once |

## Step map: teardown (deprovision-rock.sh -> deprovision)

| Bash step | JS equivalent | Parity check |
|---|---|---|
| state file load + `reqenv` | path, parsed object, or bare slug resolved against the state dir | same "no state at ..." + "missing env var" messages |
| typed-slug confirm / `AIOS_CONFIRM_DESTROY` | `opts.confirm === slug` or `AIOS_CONFIRM_DESTROY` (no TTY, divergence 6) | same refusal message |
| delete server, DNS record, tunnel connections, tunnel, deploy key (if id + repo) | same order, best-effort each | JS reads API results for deleted vs already-gone (divergence 8) |
| archive state `mv X X.destroyed.<ts>` | `renameSync`, same suffix format `YYYYMMDD-HHMMSS` | never deletes |

## What the parity test suite compares

Run: `node <scratch>/parity/test.mjs` (fixtures generated by the verbatim-extracted bash heredoc and python render block).

1. **deployment.yaml bytes**: bash heredoc vs `buildDeploymentYaml()` for 3 cases (normal 2-operator, EXTRA_YAML + CONTENT_REPO set, pathological operators ` a@x.io ,,b@y.io,`). Byte-equal.
2. **FACTORY_ENV_B64**: bash `printf | base64 -w0` vs `factoryEnvB64()`. String-equal.
3. **Key encoding**: `ssh-keygen -y -f` on the JS-written private key must emit the identical public line; `ssh-keygen -l` must fingerprint it as ED25519 with the comment; armor wrapped at 70 cols.
4. **cloud-init bytes**: the python block from provision-rock.sh vs `renderCloudInit()` with the same key/deployment.yaml/dummy tokens (values containing `$`, `&`, `\`), both SSH_RULE branches. Byte-equal.
5. **State file**: bytes vs the bash echo block; parse/serialize round trip of all 13 keys.

Result 2026-07-19: 11/11 pass on Node v24 (engine targets Node 20+: global fetch, `AbortSignal.timeout`, `subarray`).

## Intentional divergences (full text in the engine.mjs header)

1. Brain-repo seeding via GitHub Git Data API from a `TEMPLATE_REPO` (owner/repo) answer; no local template dir, no git/ssh binaries. Submodules skipped with a warning; default branch PATCHed to main.
2. Org-owned brain repos are created under `/orgs/<owner>/repos` when owner is not the token user (bash always hit `/user/repos`).
3. ed25519 keypair minted in-process; private key never touches disk.
4. deployment.yaml and rendered cloud-init live in memory only (bash used deleted temp files); bytes identical.
5. Rollback guards every resource id (the bash trap could abort mid-rollback on an unset `TUNNEL_ID` under `set -u`).
6. No TTY: defaulted fields fall back to their documented defaults instead of dying; deprovision confirm is `opts.confirm`/`AIOS_CONFIRM_DESTROY` only.
7. `url_status` DoH fallback dials the edge IP via node:https with SNI instead of curl `--resolve`.
8. deprovision inspects API results for its deleted/already-gone lines (bash only checked transport success).
9. No `.env.local` auto-load, no ANSI colour; progress goes to `emit(line)` as plain text.

Not replicable purely and knowingly dropped: nothing functional. The only bash behaviours without a JS twin are cosmetic (`clear`, ANSI colours) or replaced per the mandate (git-based seeding).

## D42 addendum (js engine only; the bash pair has NO equivalent)

The js engine is deliberately ahead of `aios-setup.sh` here; these are additions, not parity breaks in the mapped steps above:

1. **New answers** (all defaulted per D42 when absent, so headless runs stay valid): `VOCAB_AREAS_LABEL VOCAB_AREAS VOCAB_EXPERTS_LABEL VOCAB_TIERS PULSE_ENABLED HEARTBEATS DROPS_DIRECT AI_DISCLOSURE ACCESS_SSH ACCESS_BROWSER ROLE_ADMINS ROLE_SUPPORT LIFECYCLE_CONTENT LIFECYCLE_IMAGES LEAVER_DAYS`. The wizard UI (7 steps since D42: Vocabulary after Member features, Permissions before Review) feeds them through `FORM_MAP`.
2. **org-policy.yaml composition**: `buildOrgPolicyYaml()` composes the policy from the answers (operators land in `roles.admins` when `ROLE_ADMINS` is blank; the three invariants are always written locked). `REGION` keeps its documented `hel1` default in the engine for bash parity; the UI's required region select is what enforces the explicit choice.
3. **Identity render + seed overlay**: when seeding a new brain repo from `TEMPLATE_REPO`, the engine renders `CLAUDE.md` + `notes/vocabulary.md` from the template repo's own `templates/CLAUDE.md.tpl` and overlays those two plus `org-policy.yaml` on the template tree in the seed commit (same-path entries replaced). A pre-D42 template without the tpl gets its stock CLAUDE.md plus the policy + vocabulary overlays, with a warning.
4. **Shared-shape contract**: the parse/validate/slots/render block in engine.mjs is kept in lockstep with `brain-template/tools/render-identity.mjs`; byte-identical rendered output for the same policy + tpl inputs is the contract (verified by the D42 smoke test). Tampered invariants make both refuse loudly (`INVARIANT:` message; the tool exits 1, the engine aborts the seed).
5. **Bash engine behaviour**: the bash path ignores the new `AIOS_SETUP_*` variables entirely; a bash-engine seed carries the template's defaults and the operator runs `tools/render-identity.mjs` on the rock after filling `org-policy.yaml` by hand.
