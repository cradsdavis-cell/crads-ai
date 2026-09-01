// server-lib.mjs: the wizard's local web server, extracted from server.mjs (D41 phase 2)
// so the same request pipeline can drive either engine:
//   'bash' : spawn wizard/aios-setup.sh with AIOS_SETUP_* env (the VPS service path)
//   'js'   : call engine.mjs runWizard(answers, emit) in-process (the packaged .exe path)
// Identical surface either way: key gate, GET / serves the wizard page, POST /provision
// streams SSE, and the last-session.log redacts everything between __ACCESS_KEY_BEGIN__
// and __ACCESS_KEY_END__ (the private key reaches the operator ONLY).
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runWizard } from '../engine.mjs';
import { forgetHost } from '../panel/ssh-bridge.mjs';
import { registerClaudeSshConfig } from '../panel/claude-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASH_ENGINE = join(HERE, '..', 'aios-setup.sh');

// form fields -> the CLI's AIOS_SETUP_* contract (the single source of logic). The js
// engine takes the same names: engine.mjs normalizeAnswers strips the prefix.
const FORM_MAP = {
  org_name: 'AIOS_SETUP_ORG_NAME', operators: 'AIOS_SETUP_OPERATORS',
  // ONE NAME (2026-08-14, docs/naming.md): the form asks what the rock is
  // called, once. `persona` stays mapped for any caller still posting the old
  // field, but nothing in the UI sends it.
  org_display_name: 'AIOS_SETUP_ORG_DISPLAY_NAME',
  persona: 'AIOS_SETUP_PERSONA', domain: 'AIOS_SETUP_DOMAIN', region: 'AIOS_SETUP_REGION',
  feat_telegram: 'AIOS_SETUP_FEAT_TELEGRAM', feat_voice: 'AIOS_SETUP_FEAT_VOICE',
  outbound: 'AIOS_SETUP_OUTBOUND', hcloud_token: 'AIOS_SETUP_HCLOUD_TOKEN',
  cf_api_token: 'AIOS_SETUP_CF_API_TOKEN', github_token: 'AIOS_SETUP_GITHUB_TOKEN',
  brain_repo: 'AIOS_SETUP_BRAIN_REPO', content_repo: 'AIOS_SETUP_CONTENT_REPO',
  slug: 'AIOS_SETUP_SLUG',
  // D42 vocabulary + permissions (composed into org-policy.yaml by the js engine;
  // the bash engine ignores them, so its seeds carry the template defaults)
  vocab_areas_label: 'AIOS_SETUP_VOCAB_AREAS_LABEL', vocab_areas: 'AIOS_SETUP_VOCAB_AREAS',
  vocab_experts_label: 'AIOS_SETUP_VOCAB_EXPERTS_LABEL', vocab_tiers: 'AIOS_SETUP_VOCAB_TIERS',
  pulse_enabled: 'AIOS_SETUP_PULSE_ENABLED', heartbeats: 'AIOS_SETUP_HEARTBEATS',
  drops_direct: 'AIOS_SETUP_DROPS_DIRECT', ai_disclosure: 'AIOS_SETUP_AI_DISCLOSURE',
  access_ssh: 'AIOS_SETUP_ACCESS_SSH', access_browser: 'AIOS_SETUP_ACCESS_BROWSER',
  role_admins: 'AIOS_SETUP_ROLE_ADMINS', role_support: 'AIOS_SETUP_ROLE_SUPPORT',
  lifecycle_content: 'AIOS_SETUP_LIFECYCLE_CONTENT', lifecycle_images: 'AIOS_SETUP_LIFECYCLE_IMAGES',
  leaver_days: 'AIOS_SETUP_LEAVER_DAYS',
};

// createWizardServer({ engine, port, host, key, htmlPath|htmlText, log|null, onExit,
// extraAnswers }) -> the listening http.Server.
//   engine       'bash' (default) | 'js'
//   key          non-empty = every request needs ?key=<key> (WIZARD_KEY behaviour)
//   htmlText     pre-loaded page bytes (SEA path); htmlPath is read per request (dev)
//   log          path for the redacted session log, or null to keep nothing server-side
//   onExit       optional (code) hook after a provision run ends
//   extraAnswers js engine only: answers merged under the form (e.g. CLOUD_INIT_TEMPLATE)
function installAccessKey(cap, org) {
  const sshDir = join(homedir(), '.ssh');
  mkdirSync(sshDir, { recursive: true });
  const keyPath = join(sshDir, `${org}-rock.key`);
  writeFileSync(keyPath, cap.key.join('\n') + '\n', { mode: 0o600 });
  if (process.platform === 'win32') {
    const u = process.env.USERNAME || process.env.USER || '';
    spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${u}:R`], { stdio: 'ignore' });
  }
  const ip = (cap.cfg || []).map((l) => (l.match(/HostName\s+(\S+)/) || [])[1]).find(Boolean);
  if (ip) forgetHost(ip);       // fresh stamp: any stale fingerprint for this IP is expected
  const cfgPath = join(sshDir, 'config');
  const hostLine = `Host ${org}-rock`;
  let cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  if (!cfg.includes(hostLine)) {
    const block = (cap.cfg || []).map((l) => l.replace(/IdentityFile .*/, `IdentityFile ${keyPath.replace(/\\/g, '/')}`)).join('\n');
    appendFileSync(cfgPath, (cfg && !cfg.endsWith('\n') ? '\n' : '') + block + '\n');
  }
  // D56: also register the connection in the Claude Code app's settings, with
  // the right start folder: the Environment dropdown then shows it ready-made.
  // Best-effort; the manual-add instructions remain the fallback.
  // R18 (2026-08-23): /state, like every face. Inside it the rock's own
  // boot-rock.sh links /state/<name> -> brain, and the app's connect test
  // (member-connect /test) upgrades this entry to that folder once the box
  // has said what it is called; a folder nobody has confirmed is a session
  // Claude Code cannot open.
  let claudeNote = '';
  try {
    const reg = registerClaudeSshConfig({ id: `${org}-rock`, name: `${org} (rock)`, sshHost: `${org}-rock`, startDirectory: '/state' });
    claudeNote = reg.ok
      ? ` The connection was also added to the Claude Code app: open it and pick "${org} (rock)" from the Environment dropdown: the right folder is already set.`
      : '';
  } catch { /* best-effort */ }
  return `access key installed on this computer (${keyPath}; ssh config updated with "${hostLine}").${claudeNote}`
    + (claudeNote ? '' : ` To work on your hub from the Claude Code app: open its Environment dropdown, choose "+ Add SSH connection", type ${org}-rock as the SSH Host, leave the port and identity-file fields empty, and when it asks which folder to open, pick the one named after your rock (it sits inside /state).`);
}

export function createWizardServer(opts = {}) {
  const engine = opts.engine || 'bash';
  const key = opts.key || '';
  const logPath = opts.log ?? null;
  const extraAnswers = opts.extraAnswers || {};
  const html = () => (opts.htmlText ?? readFileSync(opts.htmlPath || join(HERE, 'index.html')));

  let running = false; // one provision at a time, either engine

  const server = http.createServer((req, res) => {
    if (key) {
      const k = new URL(req.url, 'http://x').searchParams.get('key');
      if (k !== key) { res.writeHead(403); res.end('locked (append ?key=...)'); return; }
    }
    if (req.method === 'GET' && (req.url.split('?')[0] === '/' || req.url.split('?')[0] === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }
    // Vendored frontend assets (tokens.css, inter/): the wizard page links them;
    // panel/vendor is the single source of truth for the token + font files.
    if (req.method === 'GET' && req.url.split('?')[0].startsWith('/vendor/')) {
      const name = req.url.split('?')[0].slice(8);
      if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) || name.includes('..')) { res.writeHead(404); res.end(); return; }
      // SEA-packaged exe has no disk files: an injected vendor map (app.mjs) wins,
      // dev disk fallback below keeps standalone runs working
      let body = (opts.vendor || {})[name] || null;
      if (!body) { try { body = readFileSync(join(HERE, '..', 'panel', 'vendor', name)); } catch { /* 404 below */ } }
      if (!body) { res.writeHead(404); res.end(); return; }
      const ct = name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
      res.writeHead(200, { 'content-type': ct });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/member') {
      // D44: hand a member off to the co-running member-connect flow (desktop
      // app only; opts.memberUrl is a getter because the port binds later)
      const mu = typeof opts.memberUrl === 'function' ? opts.memberUrl() : opts.memberUrl;
      if (mu) { res.writeHead(302, { location: mu }); res.end(); }
      else { res.writeHead(404); res.end('member connect is not running in this session'); }
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/door') {
      // D52 cross-surface nav (desktop app only; the VPS wizard has no door)
      const du = typeof opts.doorUrl === 'function' ? opts.doorUrl() : opts.doorUrl;
      if (du) { res.writeHead(302, { location: du }); res.end(); }
      else { res.writeHead(404); res.end('the home screen is not running in this session'); }
      return;
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/panel') {
      // D44: after a successful stamp the desktop app brings the control panel
      // up in place; the finish screen's button lands here.
      const pu = typeof opts.panelUrl === 'function' ? opts.panelUrl() : opts.panelUrl;
      if (pu) { res.writeHead(302, { location: pu }); res.end(); }
      else { res.writeHead(404); res.end('the control panel is not up yet; reopen the app'); }
      return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/provision') {
      if (running) { res.writeHead(409); res.end('a provision is already running'); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
        send('wizard engine starting…');
        running = true;
        let inKey = false; // the private key streams to the operator ONLY, never to the server-side log
        const feed = (chunk) => String(chunk).split('\n').forEach((l) => { if (!l.trim()) return; const c = l.replace(/\x1b\[[0-9;]*m/g, ''); send(c);
          if (c.includes('__ACCESS_KEY_BEGIN__')) { inKey = true; if (logPath) try { appendFileSync(logPath, '[access key issued to operator; redacted]\n'); } catch {} return; }
          if (c.includes('__ACCESS_KEY_END__')) { inKey = false; return; }
          if (!inKey && logPath) try { appendFileSync(logPath, c + '\n'); } catch {} });
        if (logPath) try { appendFileSync(logPath, `\n==== session ${form.org_name || '?'} ====\n`); } catch {}
        const finish = (code) => {
          send(code === 0 ? '__DONE__' : `__FAIL__ exit ${code}`);
          res.end(); running = false;
          if (opts.onExit) try { opts.onExit(code); } catch { /* observer only */ }
        };

        // autoInstallKey (desktop app): capture the marker blocks and install the key +
        // Host block into ~/.ssh, so the operator opens the Claude Code app and is in.
        let feedOut = feed;
        if (opts.autoInstallKey) {
          const cap = { key: null, cfg: null };
          feedOut = (chunk) => {
            String(chunk).split('\n').forEach((raw) => {
              const c = raw.replace(/\x1b\[[0-9;]*m/g, '');
              if (c.includes('__ACCESS_KEY_BEGIN__')) cap.key = [];
              else if (c.includes('__ACCESS_KEY_END__')) {
                try {
                  const msg = installAccessKey(cap, form.org_name || 'org');
                  feed('__ACCESS_KEY_INSTALLED__');   // machine marker: the UI swaps its finish copy on this
                  feed(msg);
                } catch (e) { feed('WARN: could not auto-install the key: ' + e.message); }
                cap.key = 'done';
              } else if (Array.isArray(cap.key)) cap.key.push(c);
              else if (c.includes('__ACCESS_CONFIG_BEGIN__')) cap.cfg = [];
              else if (Array.isArray(cap.cfg) && /^(Host |  )/.test(raw)) cap.cfg.push(raw);
            });
            feed(chunk);
          };
        }
        if (engine === 'js') {
          // same mapping as the env path, minus the process boundary
          const answers = { ...extraAnswers };
          for (const [k, v] of Object.entries(FORM_MAP)) if (form[k]) answers[v] = String(form[k]);
          if (form.staging_relax) answers.AIOS_SETUP_EXTRA_YAML = 'allow_operator_account: "true"';
          if (form.ssh_key_name) answers.OPERATOR_SSH_KEY_NAME = String(form.ssh_key_name);
          runWizard(answers, feedOut).then(
            () => finish(0),
            (err) => {
              // engine die() already emitted its ERROR line; only surface the unexpected
              if (!err || err.engine !== true) feed(`ERROR: ${err && err.message ? err.message : err}`);
              finish(1);
            },
          );
        } else {
          const env = { ...process.env };
          for (const [k, v] of Object.entries(FORM_MAP)) if (form[k]) env[v] = String(form[k]);
          // tokens also need to reach the provisioner directly
          env.HCLOUD_TOKEN = env.AIOS_SETUP_HCLOUD_TOKEN || '';
          env.CF_API_TOKEN = env.AIOS_SETUP_CF_API_TOKEN || '';
          env.GITHUB_TOKEN = env.AIOS_SETUP_GITHUB_TOKEN || '';
          if (form.staging_relax) env.AIOS_SETUP_EXTRA_YAML = 'allow_operator_account: "true"';
          if (form.ssh_key_name) env.OPERATOR_SSH_KEY_NAME = String(form.ssh_key_name);
          const pebble = spawn('bash', [opts.bashEngine || BASH_ENGINE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          pebble.stdout.on('data', feed);
          pebble.stderr.on('data', feed);
          pebble.on('close', (code) => finish(code));
        }
        req.on('close', () => { /* keep provisioning even if the tab closes */ });
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(opts.port ?? 7799, opts.host || '127.0.0.1');
  return server;
}
