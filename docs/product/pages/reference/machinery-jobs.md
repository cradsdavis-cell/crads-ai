---
title: The jobs your mineral runs by itself
summary: The 15 machinery jobs Crads AI maintains on every mineral, and what each one is for.
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

**Your mineral runs 12 of these 15.** The jobs marked no in the
Runs column are control-plane work the scheduler still knows how to do but that
never fires on a mineral of your own (a member roster to pull health for, a
shared organisation brain to refresh); they are listed so the table is the whole
scheduler, not a flattering subset of it.

A yes does not mean the job fires on every box every day: several jobs guard
themselves to nothing until they apply (no connected services means nothing to
refresh; no managing organisation means nothing to sync). The column says where
a job *can* run, and the Health card on your Overview says what yours actually
did. The When column is read from the scheduler itself; "when it applies" means
the job has a rhythm only once there is something for it to do.

| Job | What it does | When | Runs |
|---|---|---|---|
| `heartbeat` | status metadata to a managing organisation, if this mineral has one | hourly at :07 | yes |
| `org-sync` | pulls anything a managing organisation has staged for this mineral, if enrolled | every 2 min | yes |
| `org-pull` | refreshes a shared organisation brain (if enrolled) | hourly at :23 | yes |
| `org-publish` | nightly extracts to a shared organisation brain (if enrolled) | when it applies | yes |
| `backup` | encrypted snapshot of your settings and credentials; your brain rides its own repository | 03:40 | yes |
| `brain-push` | pushes your brain to your own private repo | 03:50 | yes |
| `auto-update` | restart onto the software Crads-AI published | 04:10 + a per-box offset | yes |
| `seen-drain` | keeps the "last seen" column of the device roster on Your mineral true | every 2 min | yes |
| `reconcile` | applies registry changes this box has not caught up with | every 15 min | no |
| `heartbeat-pull` | pulls each member check-in so the roster tells the truth | when it applies | no |
| `mcp-refresh` | refreshes your connected services | every 30 min | yes |
| `google-rekey` | checks your Google sign-in still works, and tells you once if it ever stops | hourly at :52 | yes |
| `custody-watch` | tells you the moment ownership, anchor, support or access grants change | every 2 min | yes |
| `gh-refresh` | renews the GitHub credential your backups use | hourly at :41 | yes |
| `state-md` | rewrites STATE.md, the page your assistant reads about this mineral | when it applies | no |
