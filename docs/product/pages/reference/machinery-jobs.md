---
title: The jobs your mineral runs by itself
search-title: The scheduled jobs your assistant runs by itself
summary: The 18 machinery jobs Crads AI maintains on every mineral, and what each one is for.
audience: public
access: public
mode: reference
generated: true
order: 30
---

> Generated from the code by docs/product/pipeline/generate.mjs. Do not edit by hand: run the generator.

Your mineral runs some of these jobs on its own. They are machinery: Crads AI
maintains them, they are shown to you read-only, and they are not the same thing as
the schedules you set for your own skills, which live on **Skills** under
**Your assistant**.

You can see the ones your mineral runs, and their last outcome, on the **Health**
card on your **Overview** page. It summarises them in a line ("3 jobs, all fine") and
expands to the individual rows.

**Your mineral runs 14 of these 18.** The jobs marked no in the
Runs column belonged to the old community servers, removed in September 2026. The
scheduler still knows them, but they never fire on a mineral of your own; they are
listed so the table is the whole scheduler, not a flattering subset of it.

A yes does not mean the job fires on every box every day: several jobs guard
themselves to nothing until they apply (no connected services means nothing to
refresh; a mineral in no team has no company brain to publish to). The column says where
a job *can* run, and the Health card on your Overview says what yours actually
did. The When column is read from the scheduler itself; "when it applies" means
the job has a rhythm only once there is something for it to do.

| Job | What it does | When | Runs |
|---|---|---|---|
| `heartbeat` | notes once an hour that this mineral is alive and signed in, for the Health card, and refreshes STATE.md; it stays on the mineral | hourly at :07 | yes |
| `org-sync` | only on old community minerals, where it pulled what the community staged; never on a mineral of your own | every 2 min | no |
| `org-pull` | refreshes the company brain and its shared skills, on a mineral in a team; does nothing otherwise | hourly at :23 | yes |
| `org-publish` | publishes facts from your work (never your personal/ folder) to the company brain each night, on a mineral in a team | when it applies | yes |
| `team-hub` | merges what each person published into the company brain (company agent only) | when it applies | yes |
| `team-slack` | keeps the company agent answering in Slack, once Slack is connected (company agent only) | when it applies | yes |
| `team-inbox` | triages the shared inbox into the company brain, read only, once the owner switches it on (company agent only) | when it applies | yes |
| `backup` | encrypted snapshot of your settings and credentials; your brain rides its own repository | 03:40 | yes |
| `brain-push` | pushes your brain to your own private repo | 03:50 | yes |
| `auto-update` | restart onto the software Crads-AI published | 04:10 + a per-box offset | yes |
| `seen-drain` | keeps the "last seen" column of the device roster on Your mineral true | every 2 min | yes |
| `reconcile` | only on old community servers, where it applied registry changes; never on a mineral of your own | every 15 min | no |
| `heartbeat-pull` | only on old community servers, where it gathered the check-ins of the minerals it ran; never on a mineral of your own | when it applies | no |
| `mcp-refresh` | refreshes your connected services | every 30 min | yes |
| `google-rekey` | checks your Google sign-in still works, and tells you once if it ever stops | hourly at :52 | yes |
| `custody-watch` | tells you the moment support access, or any other access grant to this mineral, changes | every 2 min | yes |
| `gh-refresh` | renews the GitHub credential your backups use | hourly at :41 | yes |
| `state-md` | only on old community servers, where it rewrote STATE.md; on yours the hourly check-in does this | when it applies | no |
