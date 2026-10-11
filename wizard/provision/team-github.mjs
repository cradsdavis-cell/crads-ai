// team-github.mjs: the GitHub half of "Set up a team" (Crads for teams, stage 1).
//
// Everything runs on the OWNER's computer with the owner's own GitHub sign-in
// (device flow, held in memory for the run, never written down). Every repo is
// private and lives in the owner's account; Crads-AI holds nothing.
//
// Every call is idempotent so a crashed run can simply be run again: a repo that
// already exists is reused, a file that already exists is left alone, a deploy
// key already registered on that repo counts as done.
//
// Zero dependencies; `fetcher` is injectable for tests.

const API = 'https://api.github.com';

export function githubClient(token, { fetcher = fetch } = {}) {
  const gh = async (path, init = {}) => {
    const r = await fetcher(API + path, {
      ...init,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', ...(init.headers || {}) },
    });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  };

  async function whoami() {
    const me = await gh('/user');
    if (!me.ok || !me.body || !me.body.login) throw new Error(`GitHub did not accept the sign-in (HTTP ${me.status})`);
    return me.body.login;
  }

  // Create a private repo under the signed-in account, or reuse one that is
  // already there and pushable. auto_init gives it a first commit, so a box can
  // clone it and push straight away.
  async function ensureRepo(owner, name, description) {
    const create = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name, private: true, auto_init: true, description }) });
    if (create.ok) return { created: true, fullName: `${owner}/${name}` };
    const check = await gh(`/repos/${owner}/${name}`);
    if (!check.ok) throw new Error(`could not create ${owner}/${name} (HTTP ${create.status}) and it is not readable either`);
    if (check.body && check.body.private === false) throw new Error(`${owner}/${name} already exists and is PUBLIC; a team brain must be private. Rename or delete it first.`);
    if (check.body && check.body.permissions && check.body.permissions.push === false) throw new Error(`${owner}/${name} exists but this account cannot push to it`);
    return { created: false, fullName: `${owner}/${name}` };
  }

  // Write a file only if it is not there yet: the owner may already have filled
  // in the company pages, and a re-run must never overwrite them.
  async function ensureFile(fullName, path, content, message) {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const have = await gh(`/repos/${fullName}/contents/${enc}`);
    if (have.ok) return { created: false };
    const put = await gh(`/repos/${fullName}/contents/${enc}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64') }),
    });
    if (!put.ok) throw new Error(`could not write ${path} to ${fullName} (HTTP ${put.status})`);
    return { created: true };
  }

  // Register a box's public key on a repo. GitHub refuses (422) a key already
  // used anywhere as a deploy key; if it is already on THIS repo, that is done.
  async function ensureDeployKey(fullName, title, key, readOnly) {
    const add = await gh(`/repos/${fullName}/keys`, { method: 'POST', body: JSON.stringify({ title, key, read_only: !!readOnly }) });
    if (add.ok) return { added: true };
    if (add.status === 422) {
      const list = await gh(`/repos/${fullName}/keys?per_page=100`);
      const want = keyBody(key);
      const found = list.ok && Array.isArray(list.body) && list.body.find((k) => keyBody(k.key) === want);
      if (found) {
        if (!!found.read_only !== !!readOnly) throw new Error(`a key for ${title} is on ${fullName} with the wrong access; remove it in the repo's Deploy keys and run again`);
        return { added: false };
      }
      throw new Error(`GitHub refused the key for ${title} on ${fullName}: it is already used on another repository`);
    }
    throw new Error(`could not add the key for ${title} to ${fullName} (HTTP ${add.status})`);
  }

  // Someone's leaving (stage 3): every deploy key whose title starts with their
  // box name comes off the repo. Titles are "<box-slug> (<key-name>)", written by
  // ensureDeployKey above, so the prefix match cannot catch a colleague's key.
  async function removeDeployKeys(fullName, boxSlug) {
    const list = await gh(`/repos/${fullName}/keys?per_page=100`);
    if (!list.ok) {
      if (list.status === 404) return { removed: 0 };
      throw new Error(`could not list the keys on ${fullName} (HTTP ${list.status})`);
    }
    let removed = 0;
    for (const k of Array.isArray(list.body) ? list.body : []) {
      if (!String(k.title || '').startsWith(`${boxSlug} (`)) continue;
      const del = await gh(`/repos/${fullName}/keys/${k.id}`, { method: 'DELETE' });
      if (!del.ok && del.status !== 404) throw new Error(`could not remove the key ${k.title} from ${fullName} (HTTP ${del.status})`);
      removed++;
    }
    return { removed };
  }

  // Archive, never delete: the company keeps the history of what that person's
  // assistant published (rule: never delete; archive).
  async function archiveRepo(fullName) {
    const r = await gh(`/repos/${fullName}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    if (!r.ok && r.status !== 404) throw new Error(`could not archive ${fullName} (HTTP ${r.status})`);
    return { archived: r.ok };
  }

  return { whoami, ensureRepo, ensureFile, ensureDeployKey, removeDeployKeys, archiveRepo };
}

const keyBody = (k) => String(k || '').trim().split(/\s+/).slice(0, 2).join(' ');

// The company repo's first pages. Placeholders, written once, then the owner's.
export function companySkeleton(companyName) {
  const page = (title, body) => `# ${title}\n\n${body}\n`;
  return {
    'README.md': page(`${companyName}: company brain`,
      'This private repository is your team\'s shared memory. Every assistant on the team reads it first.\n\n' +
      '- `company/`: who you are, how you sound, your policies and prices. The rules.\n' +
      '- `clients/`, `processes/`: shared knowledge.\n' +
      '- `skills/`: shared skills, installed on every person\'s assistant.\n' +
      '- `members/`: what each person\'s assistant published, with sources. Written by the company agent only.\n' +
      '- `entities/`, `digest/`, `decisions/`: merged views, rebuilt every night by the company agent.\n\n' +
      'Only the company agent can write here. Staff assistants can read it.'),
    'company/about.md': page('About us', 'What the business does, who it serves, and what it cares about. (Fill this in.)'),
    'company/voice.md': page('How we sound', 'How the business writes to clients: tone, words to use, words to avoid. (Fill this in.)'),
    'company/policies.md': page('Policies', 'Refunds, response times, what staff can promise without asking. (Fill this in.)'),
    'company/prices.md': page('Prices', 'Current prices and what each includes. (Fill this in.)'),
    'clients/README.md': page('Clients', 'One page per client that the whole team should know about.'),
    'processes/README.md': page('Processes', 'How things are done here, one page per process.'),
    'skills/README.md': page('Shared skills', 'Each folder here (`skills/<name>/SKILL.md`) is installed on every person\'s assistant as `company-<name>`.'),
    'members/README.md': page('Members', 'One folder per person, written nightly by the company agent from what that person\'s assistant published.'),
  };
}
