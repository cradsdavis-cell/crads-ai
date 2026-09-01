---
title: Connector patterns (every integration modeled the same way, degrades gracefully)
maturity: assistant-can-adopt-now
---

## What it is

Every external system the box touches (calendar, task list, inbox, messaging, a future leads/CRM store) is modeled the same way: an `enabled` flag, a named provider, and defined behaviour for what happens when it's disabled or unreachable. A stronger version adds two things not yet built: a per-connector allow-list of exactly which actions may run unattended (rather than one global propose-confirm switch covering everything), and, for any connector that holds named-row business state (a leads list, a booking sheet), a mandatory check that re-reads the target row immediately before writing to it.

## Why it matters

Without a uniform contract, every new integration reinvents its own on/off logic and its own way of failing: one skill silently skips a step when a connector is down, another crashes the whole run. And a connector holding business-critical per-row state is exactly the place where a wrong-row write does real, hard-to-catch damage: writing an update meant for one customer's row onto a different customer's row is a quiet, expensive mistake with no error message.

## How to adopt it on this box

- Use `profile.yaml`'s `accounts:` section (calendar / email / tasks / messaging, each with `enabled` + `provider`) as the template for any new bespoke connector, rather than inventing a fresh on/off convention per integration. This part already ships and every generic skill already reads it this way.
- When a connector is disabled or its tools are unreachable mid-run, skip just that connector, say so plainly, and continue the rest of the work. Never let one connector being down silently fail the whole skill. This non-blocking-failure behaviour is already the convention in the generic capture/followup skills; extend it to any bespoke connector too.
- For a connector that holds named rows of business state (a leads sheet, a booking tracker), add the re-verify step: immediately before any write, re-read the row's identifying field (customer name, booking reference) to confirm the write target, rather than trusting an index captured earlier in the same run. This is cheap to add and prevents the single costliest connector mistake.
- The **fine-grained per-connector action allow-list** (letting a trusted connector act unattended on some actions but not others, instead of one global propose-confirm setting) is not yet built and is compliance-sensitive. Treat it as a `needs-engine-release` extension to this pattern, not something to improvise per client.

## Signals you need it

- One integration going down takes a whole skill run with it instead of degrading gracefully.
- A write to an external record landed on the wrong row or the wrong customer.
- Every new integration added to a client's box needs its own bespoke on/off logic instead of reusing the same shape.
