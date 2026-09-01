---
name: write-prompt
title: "Write a prompt"
description: Author a prompt this organisation can share with its members, text they copy and paste with nothing installed on their box. Writes a well-formed package into prompts-library/, ready to offer from the dashboard Catalogue. Run in the rock's Claude Code.
category: org
---

# Skill: /write-prompt

The rock authors prompts here. This is the **authoring** surface; the dashboard Catalogue is only **distribution**, exactly as `/write-skill` is to the Skills tab.

A prompt is the one kind that **installs nothing**. It stages into each entitled member's inbox and is read in place on their Library page, so offering one never writes to their box and never waits on them to accept it. Withdraw the offer and it leaves the same way. That makes a prompt the cheapest thing this organisation can give somebody, and usually the right first thing to try.

## What you're building

```
prompts-library/<id>/
  prompt.yaml    # manifest (id, version, title, description, category, gate)
  PROMPT.md      # the text the member copies, verbatim
```

If `prompts-library/_TEMPLATE/` exists, copy it. If it does not, create the directory and write both files yourself: this skill ships with the box software and may be newer than the brain it is running in.

## How to run it

1. **Establish the intent.** One question at a time: what job is the member trying to do when they reach for this? What should they get back? What does a good answer look like, and what does a bad one look like? If the operator hands you source material (a transcript, a doc, something they already paste by hand), read it and propose the prompt from that instead of interviewing them.

2. **Pick a kebab id.** It names the directory and the manifest's `id`.

3. **Write `PROMPT.md`.** This file IS the payload: every byte is copied by the member exactly as written, so write the thing they paste, not documentation about it.
   - Name the job in the first line.
   - Say what to produce, and in what shape.
   - Say what "good" looks like, and what to do when the input is missing something, so the member does not get a confident guess.
   - Mark anything the member must supply in `[square brackets]` so the swap is obvious.
   - Write it in the member's language, not the organisation's internal shorthand.

4. **Write `prompt.yaml`:**

```yaml
id: <kebab-id>          # MUST match the directory name
version: 1              # integer; bump on every content change
title: ""               # the card heading the member reads
description: ""         # one line: when they would reach for this
category: ""            # briefing | capture | comms | box | org | other
gate: ""                # optional watch-first URL; "" = no gate
```

   `category` is **required** and must be one of those six. Publish refuses anything else **by name**, and there is no default: a prompt with an empty category is authored dead and will never reach a member.

5. **Check it before offering it.** Nothing in a prompt is executable, so there is no lint, but publishing runs `skill-scrub` across the whole library and refuses by name on a secret or a client name. Read `PROMPT.md` back once with that in mind: an example built from a real client's material is the usual way something private ends up in a prompt.

6. **Hand off.** Tell the operator it is ready and where to go: the dashboard **Catalogue** page, Prompts zone, switch it on for the members who should have it, then Publish. Do not tell them to run a command; the Catalogue is the surface.

## Rules to hold

- **The member's copy is the whole product.** They cannot see `prompt.yaml`, so anything they need to know belongs in `PROMPT.md`.
- **Never inline member-specific data.** A prompt goes to everyone entitled to it. Anything true of one member only belongs in their own brain, not here.
- **Propose the draft, do not publish it.** Authoring is yours; the offer switch is the operator's.
