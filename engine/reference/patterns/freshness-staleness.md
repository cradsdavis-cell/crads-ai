---
title: Freshness / staleness (don't trust an old fact just because it's written down)
maturity: assistant-can-adopt-now
---

## What it is

Pages carry an "updated" date, and anything marked as currently-true that hasn't been touched in a while gets flagged for a human to reconfirm rather than being repeated with full confidence forever. A page being *written down* is not the same as a page being *still right*.

## Why it matters

A business's facts change: prices move, an offering gets dropped, hours shift, a supplier changes. A brain with no staleness check will confidently repeat a fact that stopped being true months ago, and the client has no reason to notice the assistant is working from an outdated page unless they happen to catch it in the wild.

## How to adopt it on this box

- Take the "no activity for 7+ days" check `/weekly` already runs on projects and generalise it to any brain page: any page marked active/current whose `updated` date is older than a sensible threshold (shorter for prices/offerings, longer for background/history pages) gets named explicitly, and the client is asked a single yes/no: still right?
- No new engine mechanism is required for this: it's the same idea `/weekly` already applies to projects, applied more broadly to any page carrying an `updated` date.
- Set the threshold per business type: a business with fast-changing offerings (seasonal menu, promo pricing) needs a shorter window than one whose facts genuinely don't move much quarter to quarter.

## Signals you need it

- The assistant states a fact back to the client that they've since changed.
- Nobody can say, off the top of their head, when a given fact was last confirmed as still true.
- A price, offering, or policy the assistant quotes turns out to be from before a change the client made weeks ago.
