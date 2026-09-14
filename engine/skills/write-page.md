---
name: write-page
title: "Write a page"
description: Author a page for your own app, a screen that installs into the sidebar of this mineral. Writes a self-contained, lint-clean page package and installs it here. Run it from the Terminal tab.
category: box
---

# Skill: /write-page

One page, for the member's own app, written into the member's own folder. The
companion app is a shell: beyond its built-in tabs it renders whatever lives
under `/state/dashboard/`, which is the member's (three-layer model, layer 3).
`/dashboard` is the wider skill (pages and cards, config, template updates);
this one is the short path for "build me a page that shows X".

(Rewritten 2026-09-10. Until then this body described the hosted era: a rock
authoring pages into a Catalogue for members to pick up. There is no rock, no
Catalogue and no pickup any more; the page lands on this mineral, in this
member's sidebar, on the next refresh.)

## The page contract (follow exactly)

A page is an **HTML fragment** at `dashboard/pages/<id>.html` plus a manifest
entry in `dashboard/pages.json`:

```json
{ "template_version": 1, "pages": [ { "id": "welcome", "title": "Welcome" } ] }
```

- `id`: kebab-case, `[a-z0-9-]`, must match the filename (`<id>.html`). A page whose id fails this pattern is ignored by the app.
- `title` becomes the entry under **Your pages** in the sidebar.
- The fragment renders inside a **sandboxed frame**: it cannot reach the app, its storage, or its verbs, and a CSP blocks every network request, external font, CDN and image. No `<html>`, `<head>` or `<body>`. Inline the CSS and any script.
- Use the app's look: `<h2>` title, `<p class="hint">` for helper text, `.guidecard` for boxed content. The app's CSS variables are available inside the sandbox.
- Optional `<script>` tags run inside the sandbox (top-level, no modules) with `window.pageApi`: `pageApi.data()` for the mineral's live `data.json` snapshot, `pageApi.run(verb, args)` for the read-only brain verbs (`'brain-list'` and `'brain-read'` only), `pageApi.esc(s)` to HTML-escape, `pageApi.refresh()` to ask the app to re-pull. Nothing else works from a page.
- Escape ALL brain-derived text with `pageApi.esc()` before inserting it into the page's own HTML.

## How to run it

1. **Establish the intent.** What does the member look at this page to find out or to do? A reference they read, or something they interact with? If it needs data, is that data already in the brain or in `data.json`? One question if the ask is vague, not an interview.
2. **Read `dashboard/pages.json`** and the existing page files: know what is already there, and do not overwrite a page the member did not ask to change.
3. **Pick a kebab id**, write the fragment, add the manifest entry. Valid JSON, valid id, fragment only.
4. **Lint it:** `node /app/engine/appshell/page-lint.mjs dashboard/pages/<id>.html`. Fix every error. A page that will not lint renders as a blank area with no error the member can see, which is why the lint exists.
5. **Show the member the page before saving** when it is more than a few lines, then save.
6. **Tell them** the page appears in the app sidebar under **Your pages** on the next refresh (the Refresh button, or reopening the app).

## Rules to hold

- **Degrade visibly.** If something the page wants is missing, say so on the page. A member cannot debug a blank screen.
- **Never edit `/app`** (the machinery). This skill only ever writes under `/state/dashboard/`.
- **Propose the draft, do not assume it is right.** The member owns this folder.

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
