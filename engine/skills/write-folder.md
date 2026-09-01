---
name: write-folder
title: "Write a folder"
description: Author a folder of files this organisation can offer its members (templates, references, worked examples) that they install into their own brain. Writes a package into dirs-library/, ready to offer from the dashboard Catalogue. Run in the rock's Claude Code.
category: org
---

# Skill: /write-folder

The rock authors shareable folders here. Authoring is this skill; distribution is the dashboard Catalogue.

A folder is **pickup, never push**: `files/` stages into each entitled member's inbox and appears on their Library page with an Install button. Nothing is copied into their brain until they press it.

## What you're building

```
dirs-library/<id>/
  dir.yaml      # manifest (id, version, title, description, category, gate, kind)
  files/        # EVERYTHING under here, at any depth, is what the member receives
```

Copy `dirs-library/_TEMPLATE/` if it exists; otherwise create the directory yourself.

## How to run it

1. **Establish the intent.** What is the member going to do with these files? Are they templates they will edit, references they will read, or examples they will copy from? That decides how the folder is laid out and what the README beside them needs to say.

2. **Pick a kebab id**, then build `files/`. Lay it out the way you would want to find it in six months. If the contents are not self-evident, put a short `README.md` at the top of `files/` addressed to the member.

3. **Write `dir.yaml`.**
   - `category` is **required** and must be one of `briefing`, `capture`, `comms`, `box`, `org`, `other`; publish refuses anything else by name.
   - `kind` is a **different field with a confusing name**: it is a free content label (`docs`, `templates`, and so on), carried to the member byte-for-byte, matched as `[a-z0-9-]` up to 32 characters. It is not the catalogue kind, which is always `dir` for anything under `dirs-library/`.
   - Bump `version` on every content change.

4. **Read it back for secrets.** Publishing runs `skill-scrub` over the whole library and refuses by name on a key or a client name. A folder of real worked examples is the most likely place in a brain for something private to be sitting, so check before you offer it, not after.

5. **Hand off.** Tell the operator: dashboard **Catalogue** page, Folders zone, switch it on for the right members, Publish.

## Rules to hold

- **Everything under `files/` ships.** There is no ignore list. A scratch file left in there goes to every entitled member.
- **Never inline member-specific data.** One folder goes to everyone entitled to it.
- **Propose the draft, do not publish it.**
