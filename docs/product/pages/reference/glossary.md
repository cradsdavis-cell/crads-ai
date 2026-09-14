---
title: The words
summary: A plain glossary of the terms these docs use, with the page where each one first matters.
audience: public
access: public
mode: reference
order: 290
---

You do not need to learn any of these. Keep the page open in a tab and come
back when a word feels fuzzy. Each entry is one or two lines and points at
the page where the thing is actually explained.

Three tables: the thing itself, what you do with it, and what is going on
underneath.

## The thing itself

| Term | What it means here | Where you meet it |
|---|---|---|
| Assistant | The whole thing: a brain that thinks, a memory that knows you, and the services it can reach. In these docs also called your EA. | [What an AI EA is](/docs/what-an-ai-ea-is) |
| Mineral | The server you own, in your own hosting account, that everything runs on. Yours all the way down. | [What a mineral is](/docs/what-a-mineral-is) |
| Brain | Your assistant's long-term memory: plain markdown pages in a private GitHub repo you own, kept on the mineral and mirrored to GitHub. | [Brain](/docs/brain-page) |
| Layer | One of the eight sections the brain is organised into, from what you are for (layer 1) to how you work and write (layer 8). | [How your assistant thinks](/docs/how-your-assistant-thinks) |
| Skill | A saved recipe: a numbered procedure in a text file that runs when you type its name after a slash. Eleven are built in; the rest are yours. | [Skills](/docs/skills-page) |
| Recipe | A skill and a schedule set up together, with the reason for the timing. | [Starter recipes](/docs/starter-recipes) |
| Connection | A service (mail, calendar, Notion, a search service) your assistant can read, added from a catalogue of about sixty. | [What you can connect](/docs/connections) |
| Schedule | When a skill runs with nobody at the keyboard. Every schedule ships switched off. | [Skills](/docs/skills-page) |
| Terminal | The tab where you talk to your assistant. Headed "Meet your assistant" in the app. | [Terminal](/docs/terminal-page) |
| Telegram bot | A bot you own that delivers scheduled results to your phone and answers a message you send it. | [Connect Telegram](/docs/connect-telegram) |
| Card, page | A tile on your Overview, or a screen of your own in the app, built by `/dashboard` from the Terminal. | [Overview](/docs/overview-page) |
| Device | A machine allowed to open your mineral, admitted by one that already can. | [Devices and access](/docs/devices-and-access) |
| Support grant | Permission for someone to look at your mineral for a fixed time, which you can end early. | [Grant support access](/docs/grant-support-access) |
| Machinery | The jobs the mineral runs to look after itself: backups, updates, the heartbeat. Not skills, and not yours to schedule. | [Jobs your mineral runs by itself](/docs/machinery-jobs) |
| Secret | A key or token stored on the mineral so a connection works. | [Secrets](/docs/secrets-page) |

## Doing things

| Term | What it means here | Where you meet it |
|---|---|---|
| Prompt | The message you type. Plain words; longer and clearer beats short and vague. | [Prompting habits](/docs/prompting-habits) |
| CRIT | Context, role, interview, task: Geoff Woods's four-part shape for a prompt that matters. The interview step is the one people skip. | [The CRIT method](/docs/the-crit-method) |
| Run, invoke | Setting a skill off, by typing `/name` in the Terminal or pressing Run now on its row. | [Skills](/docs/skills-page) |
| The interview | The `/onboard` conversation that builds the brain from nothing, one question at a time. | [The interview](/docs/the-interview) |
| Capture | Writing a moment down. `/capture` proposes what from a session should go into the brain, and waits for your yes. | [Grow the brain](/docs/grow-the-brain) |
| Correct | Telling it what was wrong with a brief or a draft so the fix lands in the brain. The main way the brain grows. | [Grow the brain](/docs/grow-the-brain) |
| Draft | What the assistant produces for anything outbound. It never sends; you do. | [What it will not do](/docs/what-it-will-not-do) |
| Confirm | The yes it waits for before writing: one bulk confirmation for inbox labels, a shown change for capture. | [What it will not do](/docs/what-it-will-not-do) |
| Teach it your voice | Editing its drafts to taste and telling it what changed, until layer 8 holds how you write. | [Teach it your voice](/docs/teach-it-your-voice) |
| Grill me | The interview turned around on any topic: it asks, you answer, it writes the page as you go. | [Find what you do not know](/docs/find-what-you-do-not-know) |
| The council | Five opposed stances on a decision, then a separate judge: green-light, reshape, or kill. | [Find what you do not know](/docs/find-what-you-do-not-know) |
| Back up, restore | The nightly copy of your brain to your GitHub account, and getting everything back from it onto a new mineral. | [Back up and restore](/docs/back-up-and-restore) |
| Fix a connection | Telling an expired sign-in from a real fault, and putting it right from the Connections page. | [Fix a broken connection](/docs/fix-a-broken-connection) |

## How it works underneath

| Term | What it means here | Where you meet it |
|---|---|---|
| Context | What the assistant has in front of it right now: this conversation plus the brain pages it loaded. "It lacks context" means the fact is not in view. | [How your assistant thinks](/docs/how-your-assistant-thinks) |
| Context window | The ceiling on how much fits in one conversation. A pasted spreadsheet can fill it. | [How your assistant thinks](/docs/how-your-assistant-thinks) |
| Session | One conversation in the Terminal. It does not resume; what mattered has to be captured. | [A day with your assistant](/docs/a-day-with-your-assistant) |
| Hallucinate | Stating something confidently that is not true. A gap filled with a plausible guess, not a lie. Check anything load-bearing. | [What it will not do](/docs/what-it-will-not-do) |
| Model | The specific brain answering: Claude, signed in with your own account. Rented, not built. You grow the memory and add senses. | [How your assistant thinks](/docs/how-your-assistant-thinks) |
| Token | The unit the brain reads in, roughly three-quarters of a word. Why a long document fills the context window. | [How your assistant thinks](/docs/how-your-assistant-thinks) |
| MCP | The standard plug a connected service uses. One per service. | [What you can connect](/docs/connections) |
| Read-only | Looks but does not touch. `/explain` and `/followup` are read-only by design. | [What it will not do](/docs/what-it-will-not-do) |
| Repo, GitHub | A version-tracked folder of files, and the site where it lives online. Your brain is one, in your own account. | [Back up and restore](/docs/back-up-and-restore) |
| Agent | The assistant taking several steps in a row on its own. Same brain, longer leash, more to check. | [What it will not do](/docs/what-it-will-not-do) |
| The three layers | Who edits what: the machinery the project maintains, the infrastructure you own, the pages you build. | [Who edits what](/docs/the-three-layers) |
| Update | How new engine software reaches your mineral, and what it never touches. | [How updates reach you](/docs/how-updates-reach-you) |
| SSH | How a device gets into the mineral: a key on your machine, matched on the box. | [Devices and access](/docs/devices-and-access) |
| Claude Code on your mineral | Opening the whole brain in one Claude Code session over SSH, for when you want to work on the files directly. | [Claude Code on your mineral](/docs/claude-code-on-your-mineral) |

The legal words live on their own pages: the [privacy
policy](/docs/privacy-policy), the [terms of service](/docs/terms), and
[acceptable use](/docs/acceptable-use). Where a term here and a term there
disagree, the legal page wins.

If a word you met in the docs is not here, that is a gap in this page rather
than in you. The four people behind most of the ideas, and the words they
use, are on [where these ideas come from](/docs/where-these-ideas-come-from).
