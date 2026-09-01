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

**A pebble runs 12 of these 15; a rock runs 4.** That is not a
setting, it is how each is built: a rock reports to nobody, is anchored to nothing,
and has no owner-facing brain repository of the kind a pebble backs up nightly, while
the jobs marked no in the Pebble column are control-plane work only a rock has (a
member roster to pull health for, a public route to keep registered). The
consequences are worth knowing if you host one, and they are called out under the
table.

A yes does not mean the job fires on every box every day: several jobs guard
themselves to nothing until they apply (no connected services means nothing to
refresh; no joined rocks means nothing to wire). The column says where a job
*can* run, and the Health card on your Overview says what yours actually did.
The When column is read from the scheduler itself; "when it applies" means the
job has a rhythm only once there is something for it to do.

| Job | What it does | When | Pebble | Rock |
|---|---|---|---|---|
| `heartbeat` | status metadata up to your rock (see Sharing) | hourly at :07 | yes | no |
| `org-sync` | pulls what your rock has shared with this box | every 2 min | yes | no |
| `org-pull` | refreshes the shared rock brain (if enrolled) | hourly at :23 | yes | no |
| `org-publish` | nightly extracts to the rock brain (if enrolled) | when it applies | yes | no |
| `backup` | encrypted snapshot of your settings and credentials; your brain rides its own repository | 03:40 | yes | no |
| `brain-push` | pushes your brain to your own private repo | 03:50 | yes | no |
| `auto-update` | restart onto the software your rock published | 04:10 + a per-box offset | yes | no |
| `seen-drain` | keeps the "last seen" column on your Devices page true | every 2 min | yes | yes |
| `reconcile` | applies registry changes this box has not caught up with | every 15 min | no | yes |
| `heartbeat-pull` | pulls each member check-in so the roster tells the truth | when it applies | no | yes |
| `mcp-refresh` | refreshes your connected services | every 30 min | yes | no |
| `google-rekey` | checks your Google sign-in still works, and tells you once if it ever stops | hourly at :52 | yes | no |
| `custody-watch` | tells you the moment ownership, anchor, support or access grants change | every 2 min | yes | no |
| `gh-refresh` | renews the GitHub credential your backups use | hourly at :41 | yes | no |
| `state-md` | rewrites STATE.md, the page your assistant reads about this mineral | when it applies | no | yes |

## If you host a rock

Three of the jobs a rock does not run are ones a pebble owner would reasonably
assume are universal:

- **`backup` and `brain-push` do not run on a rock.** A rock does not take the
  nightly encrypted snapshot, and does not push its brain to a repository on a
  schedule. The push that happens when you turn a mineral into a rock is a one-time
  step in that upgrade, not the start of a nightly habit.
- **`auto-update` does not run on a rock.** A pebble restarts nightly onto the
  published image. A rock does not: it stays on the software it has until somebody
  restarts it, which is **Update and restart this mineral** under Help. Update your
  rock when a fix is out, and do it before you build pebbles, because a rock also
  hands its host scripts to the pebbles it builds.
- **`mcp-refresh` does not run on a rock**, so a rock's own connections are not
  refreshed for it on a schedule.
