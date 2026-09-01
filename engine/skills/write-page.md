---
name: write-page
title: "Write a page"
description: Author a page this organisation can offer its members, a screen that installs into their own app. Writes a self-contained, lint-clean package into pages-library/, ready to offer from the dashboard Catalogue. Run in the rock's Claude Code.
category: org
---

# Skill: /write-page

The rock authors member pages here. Authoring is this skill; distribution is the dashboard Catalogue.

A page is **pickup, never push**: it stages into each entitled member's inbox and appears on their Library page with an Install button. It does not land in their nav on its own, and an installed page is never overwritten by a later offer.

## What you're building

```
pages-library/<id>/
  page.yaml     # manifest (id, version, title, description, category, gate)
  page.html     # the page itself, self-contained
```

Copy `pages-library/_TEMPLATE/` if it exists; otherwise create the directory and write both files yourself.

## How to run it

1. **Establish the intent.** What does the member look at this page to find out or to do? Is it a reference they read, or something they interact with? If it needs data, whose data, and is that data already on their box?

2. **Pick a kebab id**, then write `page.html`.

3. **Self-contained or it does not work.** The page runs in a sandboxed iframe with a deny-all CSP and no network access. No CDN script, no external stylesheet, no web font, no `fetch`. Inline the CSS and any script. A page that breaks this renders as a blank area with no error the member can see, which is why the lint below exists.

4. **Write `page.yaml`** with the same six fields as a prompt manifest. `category` is **required** and must be one of `briefing`, `capture`, `comms`, `box`, `org`, `other`; publish refuses anything else by name. `title` becomes the nav entry on the member's box. Bump `version` on every content change.

5. **Lint it:** `node /app/engine/appshell/page-lint.mjs pages-library/<id>/page.html`. Fix every error. The dashboard runs the same lint at save time and refuses to save a page that fails, so a page that will not lint is a page nobody can offer.

6. **Hand off.** Tell the operator: dashboard **Catalogue** page, Pages zone, switch it on for the right members, Publish.

## Rules to hold

- **Never assume the organisation can read the member.** The page runs on their box, against their data.
- **Degrade visibly.** If something the page wants is missing, say so on the page. A member cannot debug a blank screen.
- **Propose the draft, do not publish it.**
