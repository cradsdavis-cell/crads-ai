---
name: dashboard
title: "Build pages & cards"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Build or change the member's own app pages and dashboard cards, the box-hosted surface their companion app renders. "Build me a page that shows X", "change my dashboard", "add a card for Y".
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads:
  - dashboard/pages.json       # page manifest (id + title per page)
  - dashboard/cards.json       # config-level Dashboard card overrides
  - dashboard/.template-version
---

# Skill: /dashboard  (generic)

The member's companion app is a SHELL: beyond its built-in tabs it renders whatever lives under `/state/dashboard/`. That folder is the member's own (three-layer model, layer 3), this skill is how they change it without touching code. You write the files; the app picks them up on its next refresh.

## The page contract (follow exactly)

A page is an **HTML fragment** at `dashboard/pages/<id>.html` plus a manifest entry in `dashboard/pages.json`:

```json
{ "template_version": 1, "pages": [ { "id": "welcome", "title": "Welcome" } ] }
```

- `id`: kebab-case, `[a-z0-9-]`, must match the filename (`<id>.html`). Pages whose id fails this pattern are ignored by the app.
- The fragment renders inside a **sandboxed frame** (three-layer v2, 2026-07-27): it cannot reach the app, its storage, or its verbs, and a CSP blocks ALL network requests, external fonts/CDNs/images/fetches simply fail. Everything must be inline and self-contained.
- NO `<html>`, `<head>`, or `<body>`. Use the app's look: `<h2>` title, `<p class="hint">` for helper text, `.guidecard` for boxed content. CSS variables available inside the sandbox: `--paper --card --line --ink --soft --accent --good --bad --mono`.
- Optional `<script>` tags run inside the sandbox (top-level, no modules) with `window.pageApi`:
  - `pageApi.data()` → the mineral's live `data.json` snapshot (brain counts, onboarding, connections, graph…)
  - `pageApi.run(verb, args)` → **read-only brain verbs ONLY**: `'brain-list'` `{}` and `'brain-read'` `{page:'x.md'}`, returning a Promise of `{ok, lines}`. No other verb works from a page, do not try; the bridge rejects them by design (a page must never be able to grant access, restart the mineral, or write anything).
  - `pageApi.esc(s)` → HTML-escape helper · `pageApi.refresh()` → asks the app to re-pull data.json; the fresh snapshot arrives via `window.onPageData(data)` if the page defines it
- Escape ALL brain-derived text with `pageApi.esc()` before inserting it into the page's own HTML.

## Dashboard cards (config level)

`dashboard/cards.json` overrides a built-in Dashboard card by `id` or adds new ones:

```json
{ "cards": [ { "id": "brain", "title": "Brain", "big": "{brain.pages} pages", "sub": "{brain.people} people" } ] }
```

`{a.b.c}` placeholders substitute from `data.json`. Cards are **data-only** (three-layer v2): `big`/`sub` values, always escaped. The old `html` card field is retired, cards render in the app's own window, so raw markup is never accepted there. Anything richer than a number + a line of text belongs in a page (sandboxed), not a card.

## Process

1. Read `dashboard/pages.json` + the existing page files: know what is already there.
2. Talk shape before writing if the ask is vague ("what should the page show, roughly?"), one question, not an interview.
3. Write the fragment + manifest entry. Valid JSON, valid id, fragment only.
4. Tell them: the new page appears in the app sidebar under "Your pages" on the next refresh (the ↻ Refresh button, or reopening the app).
5. Never edit `/app` (the machinery), this skill only ever writes under `/state/dashboard/`.

## Template updates

`.template-version` records which Crads/org template generation seeded this mineral. If the member asks to "get the latest template" for a page they have edited, diff the current template file against theirs, show what would change, and re-apply only with their OK, their edits win by default.

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
