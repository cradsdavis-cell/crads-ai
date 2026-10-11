---
name: propose-change
title: "Propose a change to the company brain"
description: On a team box, propose a change to a company policy, price, process, client page or shared skill. The owner approves it in the app before anyone's assistant sees it.
category: org
---

# Skill: /propose-change

Only for a box that belongs to a team (`org/config.json` exists and names a
`company`). On any other box, say plainly that there is no company brain here and
stop.

The company brain (`org/brain/`) is read-only on this box. Its rule pages
(`company/`, `clients/`, `processes/`) and shared skills (`skills/<name>/SKILL.md`)
change only when the owner approves a proposal. Facts about your own work need no
proposal: they reach the company brain every night by themselves.

## Steps

1. **Work out the target.** One page per proposal, and it must be one of:
   - `company/<page>.md` (about, voice, policies, prices, or a new one)
   - `clients/<client>.md`
   - `processes/<process>.md`
   - `skills/<name>/SKILL.md`
   Anything else (`members/`, `entities/`, `digest/`, `decisions/`) is written by the
   company agent and cannot be proposed. Say so if asked.
2. **Read the current page** in `org/brain/<target>` if it exists, and write the
   WHOLE new page, not a fragment: the owner approves exactly what they see.
   Change only what the person asked for; keep everything else as it was.
3. **Show the person the change before proposing**: the lines that change, and
   one sentence of why in their words. Do not propose until they say yes.
4. **Propose it.** Write the new page to a temporary file, then run:

   ```bash
   node /app/engine/team/team-proposals.mjs propose /state <target> <tmp-file> "<why, one sentence>"
   ```

   The answer is a `TEAM_PROPOSED {json}` line. `pushed: true` means it has left
   this box; the company agent queues it within the hour and the owner sees it in
   the app. `pushed: false` means it is saved here and goes with the next nightly
   publish.
5. **Tell the person what happens next**, plainly: the owner approves or rejects it
   in the app, and once approved every assistant on the team has it within the hour.
   If the answer listed `flags`, mention them: the owner will see the same warnings.

## Do not

- Do not edit anything under `org/brain/` directly. It is overwritten on the next
  pull, and it is not how the company brain changes.
- Do not put anything from `wiki/personal/` or an `enclave: true` page into a
  proposal. Proposals are seen by the owner and, once approved, by everyone.
- Do not write instructions aimed at other assistants into a fact page. Shared
  skills are where instructions belong, and the owner is warned about them.
