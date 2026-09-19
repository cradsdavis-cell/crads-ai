// setup-steps.mjs — the door's read of the two finishing steps a freshly built
// (or long-standing) mineral still owes: is the brain backed up to the owner's
// own GitHub, and is the mineral itself signed in to Claude?
//
// One GET, mounted by door-server the same way inventory-routes is:
//
//   GET /setup-steps?box=<alias>  ->  { reachable, github: {connected, repo}, claude: {signedIn},
//                                       assistant: {harness, source, label, ready, host, signin} }
//
// The door's finish checklist ("Your mineral is alive") polls this to render
// honest done/not-yet chips, and the same read serves a box created weeks ago.
// Facts are read where they live, on the box, over the existing SSH bridge:
//
//   - GitHub: the brain root's origin remote in .git/config, read as a file
//     rather than by shelling git (a repo mid-operation must not fail the
//     probe) — the same read member-console-state does for the seat's Backup
//     card, so the door and the seat cannot disagree about connectedness.
//     Any credential riding the URL is stripped before it leaves this server.
//   - Claude: the credential file the interactive sign-in writes,
//     /state/.claude-auth/.credentials.json, present AND non-empty — the
//     canonical presence test (engine/lib/claude-credential.mjs): a zero-byte
//     file is what a half-written sign-in leaves behind.
//
// Nothing here takes a token or writes anything: it is a read-only probe of a
// box this app already holds the key to. The box alias is validated against
// the identities this machine actually manages before anything is dialled,
// because the value becomes an ssh destination (same gate as door /probe).
//
// Injectable: probe(host, cmd) -> Promise<{code, stdout, stderr}> (tests).

// One round trip for both facts. Marker lines, parsed server-side; the
// credential file's CONTENT never rides back, only its presence.
export const SETUP_PROBE_CMD = [
  'BR=/state; [ -d /state/brain ] && BR=/state/brain',
  'u=$(grep -A3 \'^\\[remote "origin"\\]\' "$BR/.git/config" 2>/dev/null | sed -n \'s/^[[:space:]]*url[[:space:]]*=[[:space:]]*//p\' | head -1)',
  'if [ -n "$u" ]; then echo "SETUP_GITHUB $u"; else echo SETUP_GITHUB_NONE; fi',
  'if [ -s /state/.claude-auth/.credentials.json ]; then echo SETUP_CLAUDE_OK; else echo SETUP_CLAUDE_NONE; fi',
  // What the mineral thinks with (spec 2026-09-17), from the box's own single reader. An
  // image born before that reader exists prints nothing, and the answer is then the Claude
  // facts above: that image can only be a Claude Code mineral.
  '[ -f /app/engine/lib/assistant-state.mjs ] && node /app/engine/lib/assistant-state.mjs /state 2>/dev/null || true',
].join('; ');

// What the box SAYS is data, not instructions. Everything is pinned to a shape before it
// reaches a page, and the sign-in command is chosen HERE from a fixed list: a mineral never
// gets to name a command that this app will type into a terminal.
const SIGNIN = { 'claude-code': 'claude', opencode: 'opencode auth login' };
export function parseAssistant(out, claudeSignedIn) {
  const fallback = { harness: 'claude-code', source: 'signin', label: 'Claude', ready: claudeSignedIn, host: null, signin: SIGNIN['claude-code'] };
  const m = String(out || '').match(/^SETUP_ASSISTANT (\{.*\})$/m);
  if (!m) return fallback;
  let j; try { j = JSON.parse(m[1]); } catch { return fallback; }
  const harness = /^[a-z0-9-]{1,32}$/.test(String(j.harness)) ? j.harness : null;
  const source = ['signin', 'endpoint'].includes(j.source) ? j.source : null;
  if (!harness || !source) return fallback;
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/[^ -~]/g, '').slice(0, n) : null);
  return { harness, source, label: clean(j.label, 40) || 'your assistant', host: clean(j.host, 80),
    ready: j.ready === true ? true : j.ready === false ? false : null,
    signin: source === 'signin' ? (SIGNIN[harness] || null) : null };
}

// user:token@ (or token@) in an https remote is a credential; the display
// string must shed it, same discipline as member-console-state's read.
export const stripRepoUrl = (u) => String(u || '')
  .replace(/\/\/[^@/]*@/, '//')
  .replace(/\.git$/, '');

/**
 * @param {object} o
 * @param {(want: string) => (string|null)} o.resolveHost  validate a caller-supplied
 *        alias; MUST return null for anything this app does not already manage.
 * @param {(host: string, cmd: string) => Promise<{code:number,stdout:string,stderr:string}>} o.probe
 * @returns {(req, res, path) => boolean} true when the request was handled
 */
export function setupStepsRoutes({ resolveHost = () => null, probe } = {}) {
  return function handleSetupSteps(req, res, path) {
    if (!(req.method === 'GET' && path === '/setup-steps')) return false;
    (async () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const want = new URL(req.url, 'http://x').searchParams.get('box') || '';
      const host = resolveHost(String(want));
      if (!host) { json(400, { error: 'that box is not one this app is connected to' }); return; }
      const run = probe || (await import('./ssh-bridge.mjs')).runSsh;
      let r;
      try { r = await run(host, SETUP_PROBE_CMD); } catch { r = null; }
      const out = String((r && r.stdout) || '');
      // A probe that never reached the markers is an unreachable box, not two
      // false facts: the page renders "could not check", never "not yet".
      const sawGh = /SETUP_GITHUB(?:_NONE| )/.test(out);
      const sawCl = /SETUP_CLAUDE_(?:OK|NONE)/.test(out);
      if (!r || r.code !== 0 || !sawGh || !sawCl) { json(200, { reachable: false, github: null, claude: null }); return; }
      const url = (out.match(/^SETUP_GITHUB (.+)$/m) || [])[1] || '';
      json(200, {
        reachable: true,
        github: { connected: !!url, repo: url ? stripRepoUrl(url.trim()) : '' },
        // kept for one release: the app exe and the images ship independently, and an
        // older door reads only this
        claude: { signedIn: /SETUP_CLAUDE_OK/.test(out) },
        assistant: parseAssistant(out, /SETUP_CLAUDE_OK/.test(out)),
      });
    })();
    return true;
  };
}
