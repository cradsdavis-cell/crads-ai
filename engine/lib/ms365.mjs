// ms365.mjs: the one shape of a member's Microsoft 365 connection (2026-10-19).
//
// Outlook mail, calendar and contacts reach the mineral through
// @softeria/ms-365-mcp-server, baked into the image (Dockerfile.base) at
// MS365_BIN, never fetched on first use. Sign-in is Microsoft's DEVICE CODE
// flow, run ON the box: the box asks Microsoft for a short code, the page shows
// it, the member types it at microsoft.com/devicelogin on any device, and the
// token lands in the box's own cache. Nothing passes through the app, the
// operator or anyone else, and no app registration is needed: the package
// signs in with its own public Microsoft app unless the member names theirs.
//
// Two readers share this file: engine/comms/mcp-connect.mjs (the server
// definition and the row) and engine/comms/ms365-login.mjs (the sign-in run).
// Both must spawn the server with the SAME env, or the sign-in writes a cache
// the server never reads.
import path from 'node:path';

export const MS365_KEY = 'microsoft';
// CRADS_MS365_BIN exists for tests only (a fake server standing in for the
// package); on a box it is never set, so the baked path is the one written.
export const MS365_BIN = process.env.CRADS_MS365_BIN || '/opt/ms365/node_modules/.bin/ms-365-mcp-server';
// WHAT IT MAY DO. The package's `outlook` preset (mail, calendar, contacts; no
// files, no Teams) is the starting set, cut down to an explicit list because
// that preset also carries tools an unattended job should not hold: deleting
// mail, contacts and calendars; inbox RULES, which can forward every future
// message elsewhere; calendar PERMISSIONS, which share a calendar; mailbox
// settings (auto-replies); and writing downloads to disk. The same line
// Mailchimp draws (drafts, never sends a campaign; nothing deleted). An
// explicit list rather than the preset also means a package bump can never
// widen it silently. Every name was checked against the pinned package's
// outlook preset (0.158.0, 2026-10-19): a misspelt name would just vanish.
// NB --preset would override this (the package lets a preset win), so the
// server is started with --enabled-tools only.
export const MS365_TOOLS = [
  // mail
  'list-mail-messages', 'list-mail-folders', 'list-mail-child-folders', 'list-mail-folder-messages',
  'list-mail-folder-messages-delta', 'get-mail-message', 'get-mail-message-mime', 'list-mail-attachments',
  'get-mail-tips', 'get-mailbox-settings', 'create-draft-email', 'create-reply-draft', 'create-reply-all-draft',
  'create-forward-draft', 'add-mail-attachment', 'create-mail-attachment-upload-session', 'send-draft-message',
  'send-mail', 'reply-mail-message', 'reply-all-mail-message', 'forward-mail-message', 'move-mail-message',
  'copy-mail-message', 'update-mail-message', 'create-mail-folder', 'create-mail-child-folder', 'update-mail-folder',
  'list-outlook-categories', 'create-outlook-category',
  // calendar
  'list-calendars', 'list-calendar-events', 'list-calendar-events-delta', 'list-calendar-view-delta',
  'list-calendar-event-instances', 'list-specific-calendar-events', 'get-calendar-event', 'get-calendar-view',
  'get-specific-calendar-event', 'get-specific-calendar-view', 'get-schedule', 'find-meeting-times',
  'create-calendar-event', 'create-specific-calendar-event', 'update-calendar-event', 'update-specific-calendar-event',
  'cancel-calendar-event', 'accept-calendar-event', 'tentatively-accept-calendar-event', 'decline-calendar-event',
  'forward-calendar-event', 'dismiss-calendar-event-reminder', 'snooze-calendar-event-reminder',
  // contacts
  'list-outlook-contacts', 'get-outlook-contact', 'create-outlook-contact', 'update-outlook-contact',
  'list-contact-folders', 'list-contact-folder-contacts', 'list-contact-folder-child-folders', 'create-contact-in-folder',
  // reference lookups, and the one reader for an attachment's bytes
  'list-supported-time-zones', 'list-supported-languages', 'download-bytes',
];
export const MS365_ARGS = ['--enabled-tools', `^(${MS365_TOOLS.join('|')})$`];

// Everything this connection keeps lives here, under .kernel/ (never committed:
// brain-ignore.txt's required block). Disconnect deletes the directory.
export const ms365Dir = (stateDir) => path.join(stateDir, '.kernel', 'ms365');
export const ms365LoginFile = (stateDir) => path.join(ms365Dir(stateDir), 'login.json');

// Which Microsoft sign-in door. A work or school account (Microsoft 365 for
// business) signs in at `organizations`; a personal one (outlook.com, hotmail,
// live) at `consumers`. Not `common`: since June 2026 Microsoft refuses to
// renew a personal account's token minted at `common` (the package's own
// consumersAuthorityHint), which would sign a member out the first night.
export const MS365_ACCOUNTS = { work: 'organizations', personal: 'consumers' };

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a tenant is a GUID or a verified domain (contoso.com, contoso.onmicrosoft.com)
export const TENANT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{3,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/** Check a page request. Returns { error } or the normalised settings. */
export function ms365Settings(req = {}) {
  const account = String(req.account || 'work');
  if (!MS365_ACCOUNTS[account]) return { error: 'account must be work or personal' };
  const clientId = String(req.client_id || '').trim();
  const tenantId = String(req.tenant_id || '').trim();
  if (clientId && !GUID_RE.test(clientId)) return { error: 'that app ID does not look right: it is a GUID like 1a2b3c4d-…, from the app\'s Overview page' };
  if (tenantId && !TENANT_RE.test(tenantId)) return { error: 'that tenant does not look right: a directory ID (a GUID) or your domain' };
  if (tenantId && !clientId) return { error: 'a tenant only applies to your own app: add its app ID too, or leave both empty' };
  return { account, client_id: clientId.toLowerCase(), tenant_id: tenantId.toLowerCase() };
}

/** The env the server AND the sign-in run with. Files, never the OS keyring:
 *  a container has none, and the package's fallback key file is what we want,
 *  inside .kernel/ (0600, never committed). */
export function ms365Env(stateDir, s = {}) {
  const dir = ms365Dir(stateDir);
  const env = {
    MS365_MCP_TOKEN_CACHE_PATH: path.join(dir, 'token-cache.json'),
    MS365_MCP_SELECTED_ACCOUNT_PATH: path.join(dir, 'selected-account.json'),
    MS365_MCP_USE_KEYTAR: '0',
    MS365_MCP_LOG_DIR: path.join(dir, 'logs'),
    MS365_MCP_TENANT_ID: s.tenant_id || MS365_ACCOUNTS[s.account] || MS365_ACCOUNTS.work,
    CRADS_MS365_ACCOUNT: MS365_ACCOUNTS[s.account] ? s.account : 'work',
  };
  if (s.client_id) env.MS365_MCP_CLIENT_ID = s.client_id;
  return env;
}

export function ms365Def(stateDir, s = {}) {
  return { type: 'stdio', command: MS365_BIN, args: [...MS365_ARGS], env: ms365Env(stateDir, s) };
}

// Ours if it runs the baked binary: a hand-added server under the same name
// is the member's, and is never overwritten.
export const isMs365 = (def) => !!(def && def.command === MS365_BIN);

/** MSAL's device-code sentence: "To sign in, use a web browser to open the page
 *  https://login.microsoft.com/device and enter the code ABCD12345 to
 *  authenticate." (live wording 2026-10-19; older MSAL said
 *  microsoft.com/devicelogin, so the page is read from the sentence, never
 *  assumed). Returns { url, code } or null. */
export function parseDeviceMessage(text) {
  const s = String(text || '');
  const url = (s.match(/open the page\s+(https:\/\/[^\s"']+?)[.,]?\s+and enter/i) || [])[1]
    || (s.match(/https:\/\/[^\s"']*(?:\/device|devicelogin)[^\s"'.,]*/i) || [])[0];
  const code = (s.match(/enter the code\s+([A-Z0-9-]{6,16})\b/i) || [])[1];
  return url && code ? { url, code } : null;
}

/** The package prints one JSON line when --login finishes:
 *  { success, message, userData: { displayName, userPrincipalName } }. */
export function parseLoginResult(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j.success === 'boolean') return j;
    } catch { /* not that line */ }
  }
  return null;
}
