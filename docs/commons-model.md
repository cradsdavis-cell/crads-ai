# The commons model: how rocks and pebbles connect after the pivot

Status: shipped with the self-host pivot (2026-09-01). Design source: `self-host-design.md` section 3. This page describes both flows in operational terms: the community owner's and the member's.

## The idea in one paragraph

There is nothing central any more: no directory, no tunnels, no accounts. A rock is a community hub with no metal. What it shares with its members is a commons: a plain git repository the owner controls, holding the rock's curated skills, packs, prompts, pages and folders. Membership is read access to that repository, granted and revoked with the git host's own tools. A member's mineral pulls the commons on its normal rhythm, and everything that arrives is an offer in their catalogue, installed only when the member chooses. The rock holds no credential for any member box; the member holds nothing of the rock's beyond read access to the commons. Isolation in both directions is by construction.

## The commons repository

Any git host works. A private GitHub repository with invited collaborators is the documented default; a public repository makes an open community. Nothing in the software assumes GitHub: the repository URL travels in the join bundle, and https, ssh and git URL shapes are all accepted.

The repository is laid out in the same shape as a push-down inbox, because that is what every pickup surface on a member box already reads:

```
skills/<id>/                       skill packages (SKILL.md + skill.yaml)
packs/<id>/pack.yaml               pack envelopes
pages/<pack>/<id>.html             pack pages
offers-pages/<id>.html (+ .json)   standalone pages
prompts/<pack>/<id>.md             prompts (title in frontmatter, body below)
dirs/<pack>/<id>/ (+ <id>.yaml)    folders
context/                           pack context files, read in place
catalog/catalog.json               the manifest members' catalogues merge
commons.yaml                       community identity and counts
```

The commons never contains member data. The owner's roster of grants lives in the rock's own brain, and nothing a member does is written back up.

## The owner's flow

Everything lives on the Catalogue page's Commons card in the rock panel, backed by the `commons-*` verbs and `engine/community/commons-admin.mjs` plus `commons-publish.mjs` on the box.

1. Create a git repository you own (for a private community on GitHub: a private repo).
2. Set up the commons on the Catalogue page: the repository URL, an optional branch, the community name members will see, and, for ssh URLs, an optional write deploy key. For a GitHub https URL the rock's own GitHub sign-in does the pushing.
3. Author as before. Skills, packs, prompts, pages and folders are written with the existing authoring verbs and Claude Code skills into the existing library zones. Curation is the catalogue: what is in the zones is what publishes.
4. Publish. The whole catalogue is laid out in the repository in the shape above, with `catalog/catalog.json` as the manifest. Pages pass the same page lint gate as everywhere else; a failing page is skipped and named, never shipped silently.
5. Grant a member. Record a grant (a label you know them by, optionally their email or GitHub username). The panel prints their join bundle: one line starting `cradscommons1:`. Hand it to them out of band, in a direct message, never a public post. For a private GitHub commons you must also invite their GitHub account as a read collaborator on the repository; the bundle alone does not grant repository access, and the panel reminds you every time.
6. Revoke a member. Mark the grant revoked in the roster, then remove their read access on the git host; removing the host access is what actually ends the feed. What they already installed stays theirs. That is a standing ruling, not an accident.

Reviewing share-backs is the git host's ordinary review flow: a member proposes content as a fork and pull request (on GitHub) or a branch pushed where you can see it, and you merge or decline there. There is no custom review machinery to run.

## The member's flow

Everything lives on the Communities page in the member app, backed by the `community-*` verbs and `engine/community/` on the box.

1. Join. Paste the bundle from the community owner into the Communities page. The box validates it strictly and loudly, records the community, and pulls the commons for the first time. For a private GitHub commons the box reads it with your own GitHub sign-in, so the owner's collaborator invite must be accepted first; until then the page says so plainly and the box keeps trying on its own rhythm.
2. Receive. The box pulls each commons on its existing sync cadence into the same inbox area a joined rock's content always landed in. New and updated items appear as offers on the Skills and Library pages. Nothing installs by itself, ever: installing is your explicit act and runs through the existing lint and sandbox gates.
3. Belong to several. Each community has its own record, its own inbox and its own row on the page. One community failing never affects another.
4. Leave, or be revoked. Leaving removes the community and stops the pulls. If your access is removed by the owner, the page says once, honestly, that your access to that commons has ended, and then goes quiet rather than repeating errors. Either way, everything you installed remains yours.
5. Share back. Ask your assistant to prepare a share (or use the `community-share` verb): your skill, page or folder is staged in the commons layout and you get the exact steps to propose it, including fork and pull request links when the commons lives on GitHub. Your read access cannot push to the commons; nothing lands there without the owner's say.

## What a hostile commons can and cannot do

Pulling a commons never executes its content. The pull is a git clone or fetch with the transport allow-list pinned (https, ssh, git; nothing else), the URL re-validated on every run, and a size cap that removes a checkout which tries to fill the disk. Unlike an anchor inbox, a commons gets no heartbeat leg, no device key leg and no evict leg: its files sit in an inbox directory as data. What a commons author writes can only ever become active on a member box through the member installing it, and installed pages still run inside the sandboxed page frame with its deny-all content security policy. The residual risk is the same as any package channel: content you choose to install, from a community you chose to trust.
