// org-github-routes.mjs — connect a ROCK's GitHub from the app, no terminal.
//
// WHY THIS EXISTS. A rock born through the door stages no GitHub credential on
// purpose (the 2026-08-09 ownership ruling: the platform is never the default
// home for an organisation's artefacts), so it cannot create the private repos a
// pebble needs until its owner connects an account they own. Until now the only
// way to do that was `connect-github` in a terminal, which is a shell command in
// a product whose whole point is that you do not need one. Sam, on being told
// twice that this was the answer: "is there a more user friendly way".
//
// There was, and we had already built it: the MEMBER seat runs the GitHub device
// flow in place (own-brain-routes.mjs, 2026-08-05, on Sam's "I just want to be
// able to click a button and connect to GitHub"). The rock simply never got it.
// So this is the same device flow, the same registered OAuth App, pointed at the
// one place the factory reads: `gh`'s own config at GH_CONFIG_DIR on the box,
// which is exactly what `connect-github` produces.
//
// THE TOKEN NEVER TOUCHES ARGV, a command string, a log line or a response body.
// It rides the ssh command's STDIN, the same rule secrets-put follows, because a
// credential in argv is one process list away from everybody.
//
// State is per-mount and in memory: one flow at a time, gone when it ends.
//
// Injectable throughout (tests): deviceFlow, bridge, host.

// gh reads the token from stdin, so the command carries no secret.
//
// TWO THINGS THIS LEARNED THE HARD WAY (2026-08-10, Sam's first real run):
//
// 1. `gh auth login --with-token` REFUSES OUTRIGHT when GH_TOKEN or GITHUB_TOKEN
//    is set in the environment: "The value of the GH_TOKEN environment variable
//    is being used for authentication. To have GitHub CLI store credentials
//    instead, first clear the value from the environment." The command runs
//    through `bash -lc` on the box, so it inherits whatever the login shell
//    has, and every one of our own factory verbs exports exactly those names.
//    Unsetting them here is gh's own documented instruction.
//
// 2. The first version chained everything with `set -e` and printed nothing on
//    failure, because gh echoes the token back on some error paths and I did not
//    want it in a log. The result was one opaque sentence for four different
//    causes, and no way to tell which. Now each step reports WHICH it was, and
//    the message is redacted rather than withheld: a diagnosis you cannot read
//    is the same as no diagnosis.
//
// chmod is best-effort: the directory may predate this run and belong to another
// uid, and failing there used to kill the whole install before gh ever ran.
// ONE definition of where gh's config lives. The install writes it here and the
// backup leg must read it from here; deriving it twice is how they came apart.
const GH_DIR = '/state/.kernel/gh';

// WHY THIS FILE NOW CARRIES THE BACKUP'S OWN LOGIC (2026-08-12, Sam's second
// live run). The first version handed the whole job to `connect-github` and
// trusted whatever came back. Three faults in one press, all of them the same
// fault: NOTHING CHECKED THAT THE REPO ON THE OTHER END WAS THIS BRAIN'S.
//
//  1. THE NAME IS SHARED. connect-github defaults to `ai-os-brain` for every
//     rock on earth, so the second rock an account ever stamps wants a name the
//     first one took. Sam's account still held `cradsdavis-cell/ai-os-brain`
//     from the 10 Aug test round (janet-jackson, bob-jones), destroyed as
//     servers but never as repos: the box PAT cannot delete them.
//  2. ADOPT ASSUMED SAME-BRAIN. The adopt branch exists for "someone ran this
//     twice", and cannot tell that from "a different box's repo wearing this
//     name". It wired origin to a history this brain has never seen, and the
//     push was rejected non-fast-forward.
//  3. THE FAILED WIRE STAYED. connect-github adds the remote before it pushes,
//     so a rejected push left origin pointing somewhere it can never push, the
//     Custody card read that remote as "connected", and the only verb a
//     connected card offers is Push it now, which repeats the same rejection
//     forever. Sam: "There is no option to Connect GitHub again. I already
//     have." No way out of the app at all.
//
// So the app now decides the name, proves the far end before adopting it, and
// unwires a remote it added if the push did not land. connect-github still does
// the work (it owns the gitignore + untrack rules that keep credentials out of
// the push); it is simply no longer the thing that chooses where to push.
//
// EVERY QUESTION IS ASKED THROUGH `gh api`, not `git ls-remote`. gh is the thing
// we just signed in, so it is authed by construction; git's credential helper is
// one setup-git away from not being.
const BACKUP = [
  'set -u',
  `export GH_CONFIG_DIR=${GH_DIR}`,
  // Same reason as the install leg: gh refuses --with-token, and misreports the
  // account, when these are set in the login shell we inherit.
  'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN',
  'command -v gh >/dev/null 2>&1 || { echo "BACKUP_FAIL=gh-missing"; exit 0; }',
  'cd "$BR" 2>/dev/null || { echo "BACKUP_FAIL=no-brain"; exit 0; }',
  'git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main',
  // --verify, or a brain with no commits yet answers the literal string "HEAD"
  // and sails past the guard into a push that cannot work.
  'LOCAL="$(git rev-parse --verify -q HEAD 2>/dev/null || true)"',
  '[ -n "$LOCAL" ] || { echo "BACKUP_FAIL=empty-brain"; exit 0; }',
  'HAD="$(git remote get-url origin 2>/dev/null || true)"',
  // owner/name out of either URL shape, so one line answers for https and ssh.
  // SINGLE-QUOTED, and that is load-bearing: `"s#\\.git$##"` in double quotes
  // makes the shell expand `$#` to the argument count, so the expression became
  // `s#\.git1#` and sed died. slug_of then returned empty, every `gh api
  // repos//commits` missed, and the two checks that depend on it — is this
  // remote ours, did the push land — BOTH silently answered "no idea" and
  // defaulted to the wrong branch. Caught by the driven tests below, which is
  // the entire reason they exist.
  "slug_of() { printf %s \"$1\" | sed -e 's#^https://[^/]*/##' -e 's#^git@[^:]*:##' -e 's#\\.git$##'; }",
  // Is the tip of that repo an object THIS brain holds? If it is, we put it
  // there and the repo is ours. If the repo has commits we have never seen, it
  // belongs to another box: this is the whole test, and it is decisive.
  'ours() { S="$(gh api "repos/$1/commits?per_page=1" -q ".[0].sha" 2>/dev/null || true)";'
    + ' [ -z "$S" ] && return 0;'                       // no commits yet: free to adopt
    + ' git cat-file -e "$S^{commit}" 2>/dev/null; }',
  // THE REPOINT. A wired origin that fails this test is the dead end Sam hit.
  // Dropping it is not a loss: nothing of ours was ever pushed there, and the
  // repo itself is untouched.
  'if [ -n "$HAD" ] && ! ours "$(slug_of "$HAD")"; then',
  '  git remote remove origin 2>/dev/null || true; HAD=""; echo "BACKUP_REPOINTED=1"',
  'fi',
  // THE NAME CARRIES THE ORG, so two rocks from one account never collide.
  // wizard/aios-setup.sh has named it "$ORG_NAME-brain" since the beginning;
  // connect-github's org-blind default is the odd one out.
  'REPO=""',
  'if [ -z "$HAD" ]; then',
  '  OWNER="$(gh api user -q .login 2>/dev/null || true)"',
  '  ORG="$(sed -n \'s/^[[:space:]]*name:[[:space:]]*"\\{0,1\\}\\([^"#]*\\)"\\{0,1\\}.*/\\1/p\' "$BR/org-policy.yaml" 2>/dev/null | head -1)"',
  '  ORG="$(printf %s "$ORG" | tr "[:upper:]" "[:lower:]" | tr -d " \\t\\r" | sed "s/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//")"',
  '  BASE="${ORG:+$ORG-brain}"; BASE="${BASE:-ai-os-brain}"',
  '  for CAND in "$BASE" "$BASE-2" "$BASE-3" "$BASE-4"; do',
  '    if [ -z "$OWNER" ] || ! gh repo view "$OWNER/$CAND" >/dev/null 2>&1; then REPO="$CAND"; break; fi',
  '    if ours "$OWNER/$CAND"; then REPO="$CAND"; break; fi',
  '  done',
  '  [ -n "$REPO" ] || { echo "BACKUP_FAIL=no-free-name"; exit 0; }',
  'fi',
  // STATE_DIR is still handed in explicitly: rocks already standing run the old
  // script, whose rock branch never fired, and naming the brain takes its
  // else-branch to the right directory. GH_CONFIG_DIR likewise, or it looks for
  // the token under the brain, finds none, and starts a fresh interactive device
  // login that waits until the watchdog kills it (2026-08-10, read off the box).
  // </dev/null makes any prompt fail in seconds rather than hang.
  'if [ -n "$REPO" ]; then OUT="$(STATE_DIR="$BR" connect-github "$REPO" </dev/null 2>&1 || true)";',
  'else OUT="$(STATE_DIR="$BR" connect-github </dev/null 2>&1 || true)"; fi',
  // VERIFY, rather than believe the exit code. connect-github reports its own
  // success from the push it just ran; this asks GitHub.
  'NOW="$(git remote get-url origin 2>/dev/null || true)"',
  'if [ -n "$NOW" ]; then',
  '  SLUG="$(slug_of "$NOW")"',
  '  TIP="$(gh api "repos/$SLUG/commits?per_page=1" -q ".[0].sha" 2>/dev/null || true)"',
  '  if [ "$TIP" = "$LOCAL" ] || { [ -n "$TIP" ] && git cat-file -e "$TIP^{commit}" 2>/dev/null; }; then',
  '    echo "BACKUP_REPO=$SLUG"; exit 0',
  '  fi',
  'fi',
  // A REMOTE WE ADDED AND COULD NOT PUSH TO DOES NOT SURVIVE THIS FUNCTION. That
  // wire is what made the card claim a backup that had never happened, and what
  // left the owner with one button that could only fail.
  'if [ -z "$HAD" ] && [ -n "$NOW" ]; then git remote remove origin 2>/dev/null || true; echo "BACKUP_UNDONE=1"; fi',
  'echo "BACKUP_FAIL=push"',
  'printf %s "$OUT" | tail -6',
].join('\n');

const INSTALL = [
  `export GH_CONFIG_DIR=${GH_DIR}`,
  'mkdir -p "$GH_CONFIG_DIR" 2>/dev/null || true',
  'chmod 700 "$GH_CONFIG_DIR" 2>/dev/null || true',
  'unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN',
  'command -v gh >/dev/null 2>&1 || { echo "STEP=gh-missing"; exit 10; }',
  'if ! OUT="$(gh auth login --with-token --hostname github.com 2>&1)"; then '
    + 'echo "STEP=login"; printf %s "$OUT" | head -3; exit 11; fi',
  'gh auth setup-git >/dev/null 2>&1 || true',
  'if ! WHO="$(gh api user -q .login 2>&1)"; then '
    + 'echo "STEP=whoami"; printf %s "$WHO" | head -3; exit 12; fi',
  'echo "LOGIN=$WHO"',
].join('; ');

// A token must never reach a log or a UI, but the sentence around it must.
const REDACT = (s) => String(s || '')
  // Underscores included on purpose: a real gho_ token has none, but redaction
  // that only catches the shapes you predicted is redaction you cannot trust.
  .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '<token>')
  .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '<token>')
  .replace(/[A-Za-z0-9_-]{40,}/g, '<token>');

import { BRAIN_ROOT_SH } from '../../engine/lib/brain-root.mjs';

// The brain's location, from the ONE shared resolver (engine/lib/brain-root.mjs).
// This module's old local copy was missing the member-born leg ([ -d "$BR" ]
// || BR=/state), so on a promoted rock the gh credential probe looked for a
// brain at /state/brain that does not exist — the same finding-107 family bug
// as every other hand copy. The import costs nothing for standalone tests:
// the module is pure constants + fs-reading functions.
const BRAIN_ROOT_RESOLVE = BRAIN_ROOT_SH;

// THE BRIDGE KILLS ANYTHING OVER 25 SECONDS. That watchdog is right about hung
// verbs (a hang holds a concurrency slot AND a box-side connection, and hangs
// compound into the saturation that caused them) and wrong about LONG ones, so
// the long ones say how long. invite-member already learned this and carries
// timeoutMs: 15 minutes; these routes call the bridge directly, so they set it
// themselves.
//
// Found by Sam, 2026-08-10: "ssh to test-org-4-rock exceeded 25000ms; killed".
// The first backup pushes the whole brain to a brand new repository, which is
// minutes of work on a normal link, not a hang. The member seat's own push has
// carried `hardTimeoutMs: 600000` since it was built (own-brain.mjs). This route
// was written by copying that flow's SHAPE and not its hard-won settings.
const INSTALL_MS = 2 * 60 * 1000;    // a handful of GitHub API calls, generously
const BACKUP_MS = 15 * 60 * 1000;    // a first push of an entire brain

// The scopes gh will accept AND the preflight actually uses. Exported so the
// test can pin them: a scope list is the kind of thing that only fails live.
export const GH_SCOPES = 'repo read:org';

// What a person should be told for each step that can fail.
const STEP_REASON = {
  'gh-missing': 'This rock’s software is missing the GitHub tool it needs. Restart the rock to pick up the latest published software, then try again.',
  login: 'GitHub approved the sign-in, but this rock could not store the account.',
  whoami: 'The account was stored, but this rock could not read it back from GitHub.',
};

export const CONNECTED_STEPS = {
  waiting: 'Waiting for you to approve the code on github.com',
  installing: 'Approved. Handing the account to your rock',
  done: 'Connected',
};

// What a person should be told for each way the backup can end short. The rule
// is the one the install leg learned at trap 21: a diagnosis you cannot read is
// the same as no diagnosis, and raw git porcelain ("See the 'Note about
// fast-forwards' in 'git push --help'") is not readable by the person this
// product is for. That sentence is exactly what Sam was shown.
const BACKUP_REASON = {
  'gh-missing': 'This rock’s software is missing the GitHub tool it needs. Restart the rock to pick up the latest published software, then try again.',
  'no-brain': 'This rock has no brain directory to back up yet.',
  'empty-brain': 'The brain has nothing saved in it yet, so there is nothing to copy. It will back up after its first session.',
  'no-free-name': 'Every repository name we tried is already held by another box on this GitHub account. Rename or archive one on github.com, then try again.',
  push: 'GitHub would not accept the copy, so nothing was wired up. Nothing on GitHub was changed; press the button again to retry.',
};

// ONE PRESS, BOTH JOBS, and now one place. The token and the brain's offsite
// repo need the same account, so connecting does both; but the Custody card also
// needs to run JUST this half, for a rock that is already signed in and only
// owes a push. Sharing the leg is what stops those two paths drifting: the
// version where the card had its own dumber verb (`org-brain-push`, a bare `git
// push`) is the one that could only ever repeat the same rejection.
export async function backupLeg(bridge, target, state, login = '') {
  state.stage = 'backing-up';
  state.backupError = '';
  state.steps = [...(state.steps || []), 'Preparing your private backup repository'];
  let text = '';
  try {
    const bk = await bridge(target, `${BRAIN_ROOT_RESOLVE}\n${BACKUP}`, { hardTimeoutMs: BACKUP_MS });
    text = String((bk && bk.stdout) || '') + String((bk && bk.stderr) || '');
  } catch (e) {
    state.backupError = REDACT(String(e && e.message ? e.message : e)).slice(0, 200);
    state.steps = [...state.steps, `The backup repository did not finish: ${state.backupError}`];
    return false;
  }
  // Said out loud because it is a surprising thing to do silently: the remote it
  // was pointing at was another box's, and we moved it rather than going on
  // failing against it.
  if (/^BACKUP_REPOINTED=1$/m.test(text)) {
    state.repointed = true;
    state.steps = [...state.steps, 'That repository holds another box’s brain, so this one gets its own'];
  }
  const ok = text.match(/^BACKUP_REPO=(\S+)$/m);
  if (ok) {
    state.repo = ok[1].includes('/') ? ok[1] : `${login}/${ok[1]}`;
    state.steps = [...state.steps, `Backed up to ${state.repo}`];
    return true;
  }
  const why = (text.match(/^BACKUP_FAIL=(\S+)$/m) || [, ''])[1];
  // The plain sentence first, then connect-github's own last useful line behind
  // it: withholding the detail is how four causes became one unreadable
  // sentence, and quoting it raw is how one of them became a git manpage.
  const detail = REDACT(text.replace(/^BACKUP_[A-Z_]+=.*$/gm, '').trim()).split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(Let's connect|✓|On your phone|Waiting for|hint:|To https|error: failed to push)/.test(l))
    .pop() || '';
  state.backupError = (BACKUP_REASON[why] || 'The backup repository did not finish.')
    + (detail && !BACKUP_REASON[why] ? ` It said: ${detail.slice(0, 160)}` : '');
  // A remote we added and could not push to is gone again (the box removed it),
  // so the card falls back to "no offsite copy" and offers Connect GitHub —
  // rather than latching to a connected-looking remote with one button that can
  // only fail.
  state.steps = [...state.steps, `The backup repository did not finish: ${state.backupError.slice(0, 200)}`];
  return false;
}

export function createOrgGitHubRoutes({ host = () => null, state = {}, opts = {} } = {}) {
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // FINDING 199: these routes took no body at all, so the page had no way to
  // say WHICH rock it was showing, and the host() fallback quietly picked the
  // first one. The page now posts { host }, and host(want) validates it.
  // Tolerant of the test doubles' bare { method, url } request objects.
  const readBody = (req) => new Promise((resolve) => {
    if (typeof req.on !== 'function') { resolve({}); return; }
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
  const wantedHost = (body) => (body && typeof body.host === 'string' ? body.host : '');

  async function run(flow, target) {
    const bridge = opts.bridge || (await import('./ssh-bridge.mjs')).runSsh;
    state.steps = ['Waiting for you to approve the code on github.com'];
    let grant;
    try {
      grant = await flow.poll();
    } catch (e) {
      state.stage = 'failed';
      state.reason = `GitHub sign-in did not complete (${String(e && e.message ? e.message : e).slice(0, 120)}).`;
      return;
    }
    if (!grant || !grant.ok || !grant.token) {
      state.stage = 'failed';
      // access_denied and expired_token are the two a person actually causes.
      //
      // THIS READ THE WRONG KEY UNTIL 2026-08-13, and the tests agreed with it.
      // startDeviceFlow's poll() resolves `{ ok:false, reason }` and has never
      // set `.error` on any path (github-device-flow.mjs:50-57). So
      // `grant.error` was always undefined, `/denied/i` never matched, and the
      // declined branch was UNREACHABLE IN PRODUCTION: every owner who pressed
      // Cancel on github.com was told their code had expired and to get a fresh
      // one, which sends them round the loop again instead of telling them what
      // they just did. The sentence that matters most there is the one they
      // never saw, "Nothing changed".
      //
      // It survived because the fixtures fabricated `{ ok:false, error:
      // 'access_denied' }`, a shape the real flow cannot produce. That is the
      // third time in this repo that a check sharing a source with the thing it
      // checks has proved nothing (findings 67 and 70 were the first two), and
      // it is exactly why reconcile.mjs talks to the live stores instead.
      //
      // Both keys are read now: `reason` is what the flow sends, `error` is
      // tolerated so an injected or future shape cannot silently lose the
      // distinction again.
      const why = String((grant && (grant.reason || grant.error)) || '');
      state.reason = /denied|cancel/i.test(why)
        ? 'The sign-in was declined on github.com. Nothing changed; press Connect GitHub to try again.'
        : 'The code expired before it was approved. Press Connect GitHub for a fresh one.';
      return;
    }
    state.stage = 'installing';
    state.steps = [...state.steps, 'Approved. Handing the account to your rock'];
    let out;
    try {
      out = await bridge(target, INSTALL, { stdin: grant.token + '\n', hardTimeoutMs: INSTALL_MS });
    } catch (e) {
      state.stage = 'failed';
      state.reason = `Could not reach your rock to store the account (${String(e && e.message ? e.message : e).slice(0, 120)}).`;
      return;
    }
    const text = String((out && out.stdout) || '') + String((out && out.stderr) || '');
    const login = (text.match(/^LOGIN=(.+)$/m) || [, ''])[1].trim();
    if ((out && out.code !== 0) || !login) {
      state.stage = 'failed';
      const step = (text.match(/^STEP=(\S+)$/m) || [, ''])[1];
      // The redacted detail, not the whole of stdout: gh prints the token back on
      // some error paths, and withholding everything is how the first version
      // turned four causes into one unreadable sentence.
      const detail = REDACT(text.replace(/^STEP=\S+$/m, '').trim()).split('\n').filter(Boolean)[0] || '';
      state.reason = (STEP_REASON[step] || 'This rock could not complete the sign-in.')
        + (detail ? ` It said: ${detail.slice(0, 200)}` : '')
        + ' Nothing was changed on GitHub; press Connect GitHub to try again.';
      return;
    }
    state.login = login;
    state.steps = [...state.steps, `Connected as ${login}`];

    // ONE PRESS, BOTH JOBS. The token and the brain's offsite repo need the same
    // account, and the Custody card presses this button too, so leaving the
    // backup unconnected would make that card go on saying "no offsite copy"
    // right after the owner connected GitHub.
    //
    // connect-github is reused rather than reimplemented: it already knows a
    // rock from a pebble, targets the org brain, and carries the gitignore and
    // untrack rules that keep credentials out of the push. With gh already
    // signed in above it runs straight through, no prompts.
    //
    // FAIL-SOFT: the factory is armed the moment the token lands, which is the
    // job that was blocking pebbles. A backup that does not take is reported,
    // not treated as a failed sign-in.
    await backupLeg(bridge, target, state, login);
    state.stage = 'done';
  }

  return function handleOrgGitHubRoute(req, res, path) {
    if (req.method === 'POST' && path === '/org-github/start') {
      (async () => {
        const target = host(wantedHost(await readBody(req)));
        if (!target) { json(res, { error: 'This app is not connected to that rock right now.' }); return; }
        const deviceFlow = opts.deviceFlow || (await import('./github-device-flow.mjs')).startDeviceFlow;
        let flow;
        try {
          // 'repo' creates the PRIVATE repository and registers a deploy key on
          // it, which is what a stamp does. 'read:org' is required TWICE over:
          // `gh auth login --with-token` refuses a token without it ("error
          // validating token: missing required scope 'read:org'", the 2026-08-10
          // live failure), and our own preflight calls `gh api user/orgs` to
          // check the token can act for the owner when that owner is an
          // organisation rather than a personal login. Anything wider than these
          // two would be asking for permission we never use.
          flow = await deviceFlow({ scope: GH_SCOPES });
        } catch (e) {
          json(res, { error: `GitHub did not start the sign-in (${String(e && e.message ? e.message : e).slice(0, 120)}).` });
          return;
        }
        state.stage = 'waiting';
        state.target = target;   // which rock this flow is FOR (finding 199)
        state.reason = '';
        state.login = '';
        state.repo = '';
        state.backupError = '';
        state.repointed = false;
        // THE CODE IS REMEMBERED, not just answered once. Until 2026-08-13 the
        // user code existed only in the reply to THIS request, so the only thing
        // that ever knew it was the browser tab that asked. Reload that tab and
        // the card fell back to a bare "Connect GitHub" while the server was
        // still sitting in `waiting`, polling GitHub for a code the screen no
        // longer showed. The instruction on the card is "On your phone or any
        // browser open github.com/login/device", so leaving the page is the
        // EXPECTED behaviour, and the app restarting or the panel repainting did
        // it too. Worse than losing it: the card then offers Connect GitHub
        // again, and pressing that mints a SECOND device code, which quietly
        // invalidates the one the owner is holding on their phone.
        state.userCode = flow.userCode;
        state.verificationUri = flow.verificationUri;
        state.steps = ['Waiting for you to approve the code on github.com'];
        // Not awaited: the browser gets its code immediately and polls /status.
        run(flow, target).catch((e) => {
          state.stage = 'failed';
          state.reason = String(e && e.message ? e.message : e).slice(0, 160);
        });
        json(res, { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn });
      })().catch((e) => {
        try { json(res, { error: String(e && e.message ? e.message : e).slice(0, 160) }); } catch { /* already answered */ }
      });
      return true;
    }

    // JUST THE BACKUP HALF. A rock that is already signed in and owes only a
    // push has no business being sent back through a device code, and the card's
    // old answer for it (`org-brain-push`, a bare `git push` on the box) had no
    // idea the remote could be the wrong repo. This runs the same leg the
    // connect flow runs, so it repoints, names and verifies identically, and
    // reports through the same /status the card already polls.
    if (req.method === 'POST' && path === '/org-github/backup') {
      (async () => {
        const target = host(wantedHost(await readBody(req)));
        if (!target) { json(res, { error: 'This app is not connected to that rock right now.' }); return; }
        if (state.stage === 'waiting' || state.stage === 'installing' || state.stage === 'backing-up') {
          json(res, { error: 'Already working on this one. Watch the progress below.' }); return;
        }
        state.target = target;   // which rock this flow is FOR (finding 199)
        state.reason = '';
        state.repo = '';
        state.repointed = false;
        state.steps = [];
        (async () => {
          const bridge = opts.bridge || (await import('./ssh-bridge.mjs')).runSsh;
          await backupLeg(bridge, target, state);
          state.stage = 'done';
        })().catch((e) => {
          state.stage = 'failed';
          state.reason = REDACT(String(e && e.message ? e.message : e)).slice(0, 160);
        });
        json(res, { started: true });
      })().catch((e) => {
        try { json(res, { error: String(e && e.message ? e.message : e).slice(0, 160) }); } catch { /* already answered */ }
      });
      return true;
    }

    if (req.method === 'GET' && path === '/org-github/status') {
      // login is a public account name; the token is not in this object at all.
      // userCode is likewise not a secret: it is the string the owner is asked to
      // type into github.com, and it is useless without the account that approves
      // it. Returning it is what lets a reloaded card show the code it is still
      // waiting on, instead of a button that would mint a second one.
      const pending = state.stage === 'waiting';
      json(res, {
        stage: state.stage || 'idle', steps: state.steps || [], reason: state.reason || '',
        // target: which rock this flow ran against (finding 199), so the
        // card can refuse to paint another mineral's outcome as its own.
        target: state.target || '',
        login: state.login || '', repo: state.repo || '', backupError: state.backupError || '',
        repointed: !!state.repointed,
        userCode: pending ? (state.userCode || '') : '',
        verificationUri: pending ? (state.verificationUri || '') : '',
      });
      return true;
    }

    return false;
  };
}
