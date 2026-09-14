// diagrams.mjs - inline SVG diagrams, in the site's own design language.
//
// Referenced from a page exactly like a screenshot:  ![alt](diagram:self-host-path)
//
// WHY HAND-AUTHORED SVG RATHER THAN MERMAID. Mermaid would need either a CDN
// script (a request, a dependency, and a CSP problem) or a build-time renderer,
// and either way it produces something that looks like mermaid rather than like
// this site. These diagrams carry concepts, not UI, so they do not rot the way a
// screenshot does: what changes underneath them is the wording, and that is in
// this file.
//
// EVERY COLOUR IS `currentColor` OR A SITE TOKEN. Nothing here carries a hex, so
// a diagram inherits the page it sits on and cannot drift from the palette.
// Every diagram carries a <title> and <desc>, which is what a screen reader
// reads and what a reader gets if the SVG fails to paint.
//
// EVERY DIAGRAM IS REFERENCED BY A PAGE (gate in gates.test.mjs, 2026-09-10).
// The first three diagrams in this file sat unreferenced for two weeks and two
// of them went stale (they still described the hosted era's invitation and
// rock), which nothing caught because nothing rendered them. A diagram no page
// shows is a diagram nobody proofreads; the gate makes an orphan a failed build.

const T = {
  ink: 'var(--ink-deep)',
  soft: 'var(--ink-soft)',
  faint: 'var(--ink-faint)',
  rule: 'var(--rule)',
  accent: 'var(--accent)',
  accentDeep: 'var(--accent-deep)',
  good: 'var(--good)',
  card: 'var(--bg-card)',
  cardHi: 'var(--bg-card-hi)',
  soft2: 'var(--bg-soft)',
  main: 'var(--bg-main)',
};

const wrap = (id, title, desc, vb, inner) => `<figure class="diagram">
<svg viewBox="${vb}" role="img" aria-labelledby="${id}-t ${id}-d" class="dgm">
<title id="${id}-t">${title}</title><desc id="${id}-d">${desc}</desc>
<defs><marker id="${id}-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0.5 L7.5 4 L0 7.5 z" fill="${T.faint}"/></marker></defs>
${inner}
</svg>
<figcaption>${title}</figcaption>
</figure>`;

// A rounded box with a bold label and an optional second line.
const box = (x, y, w, h, label, sub, opts = {}) => {
  const fill = opts.fill || T.soft2;
  const stroke = opts.stroke || T.rule;
  const sw = opts.strokeWidth || 1;
  const cy = sub ? y + h / 2 - 7 : y + h / 2;
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
    + `<text x="${x + w / 2}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="${T.ink}" font-size="13.5" font-weight="600">${label}</text>`
    + (sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 10}" text-anchor="middle" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">${sub}</text>` : '')
    + '</g>';
};

const arrow = (id, x1, y1, x2, y2, label, opts = {}) => {
  const d = opts.d || `M${x1} ${y1} L${x2} ${y2}`;
  const lx = opts.lx ?? (x1 + x2) / 2;
  const ly = opts.ly ?? (y1 + y2) / 2 - 8;
  const anchor = opts.anchor || 'middle';
  return `<g><path d="${d}" fill="none" stroke="${opts.stroke || T.faint}" stroke-width="1.4"`
    + `${opts.dash ? ` stroke-dasharray="${opts.dash}"` : ''} marker-end="url(#${id}-a)"/>`
    + (label ? `<text x="${lx}" y="${ly}" text-anchor="${anchor}" fill="${T.faint}" font-size="11.5">${label}</text>` : '')
    + '</g>';
};

const note = (x, y, text, anchor = 'start') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${T.faint}" font-size="11.5" font-style="italic">${text}</text>`;

const eyebrow = (x, y, text, color = T.faint) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="11.5" letter-spacing="0.06em">${text}</text>`;

// A wide horizontal band with a label at left and a right-hand annotation.
const band = (x, y, w, h, label, sub, right, opts = {}) => [
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${opts.fill || T.soft2}" stroke="${opts.stroke || T.rule}" stroke-width="${opts.strokeWidth || 1}"/>`,
  `<text x="${x + 18}" y="${y + h / 2 - (sub ? 8 : 0)}" dominant-baseline="middle" fill="${T.ink}" font-size="14" font-weight="600">${label}</text>`,
  sub ? `<text x="${x + 18}" y="${y + h / 2 + 11}" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">${sub}</text>` : '',
  right ? `<text x="${x + w - 18}" y="${y + h / 2}" dominant-baseline="middle" text-anchor="end" fill="${opts.rightColor || T.accentDeep}" font-size="12.5" font-weight="600">${right}</text>` : '',
].join('');

// --- 1. how a mineral comes to exist and becomes yours (self-host era) ---------
const selfHostPath = () => {
  const id = 'd-path';
  const y = 54;
  const inner = [
    eyebrow(0, 18, 'ABOUT FIFTEEN MINUTES'),
    eyebrow(452, 18, 'ABOUT AN HOUR', T.accent),
    box(0, y, 128, 56, 'Your token', 'your own account'),
    arrow(id, 132, y + 28, 168, y + 28),
    box(172, y, 128, 56, 'Built', 'a server exists'),
    arrow(id, 304, y + 28, 340, y + 28),
    box(344, y, 128, 56, 'Open it', 'the app connects'),
    arrow(id, 476, y + 28, 512, y + 28),
    box(516, y, 128, 56, 'Sign in Claude', 'your subscription', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 648, y + 28, 684, y + 28),
    box(688, y, 132, 56, 'The interview', 'it builds a brain', { stroke: T.accent, fill: T.cardHi, strokeWidth: 1.6 }),
    `<path d="M508 40 L508 148" stroke="${T.accent}" stroke-width="1" stroke-dasharray="3 4" fill="none" opacity="0.6"/>`,
    note(0, 138, 'Built in your hosting account, with your key as the only key on it.'),
    note(516, 138, 'Inert until this. Awake once it knows you.'),
  ].join('\n');
  return wrap(id, 'How a mineral becomes yours',
    'Five steps left to right: your own hosting token, a server built in your own account, the app opening it, Claude signed in on your own subscription, and the interview that gives it a brain. The first three take about fifteen minutes; the last two about an hour. The server carries only your key from its first boot, and it is inert until Claude is signed in.',
    '0 0 824 152', inner);
};

// --- 2. who can see what (self-host era) --------------------------------------
const whoSees = () => {
  const id = 'd-sees';
  const inner = [
    `<rect x="0" y="28" width="330" height="184" rx="12" fill="${T.soft2}" stroke="${T.rule}"/>`,
    eyebrow(16, 50, 'YOUR MINERAL'),
    box(16, 62, 132, 52, 'Your brain', 'pages, notes'),
    box(160, 62, 154, 52, 'Your credentials', 'keys and tokens'),
    box(16, 126, 298, 46, 'Everything your assistant reads and writes'),
    `<text x="16" y="196" fill="${T.accent}" font-size="12" font-weight="600">None of this leaves the machine.</text>`,
    box(452, 34, 176, 52, 'Your providers', 'host, Anthropic, GitHub'),
    box(452, 130, 176, 52, 'Crads AI', 'writes the software'),
    arrow(id, 338, 60, 446, 60, 'billed to you directly', { lx: 392, ly: 46 }),
    arrow(id, 446, 156, 338, 156, 'only if you let us in', { lx: 392, ly: 174, dash: '4 4' }),
    note(452, 104, 'They run the server, the model, the backup.'),
    note(452, 200, 'Never otherwise. Time-boxed, and logged.'),
  ].join('\n');
  return wrap(id, 'Who can see what',
    'Your brain and your credentials stay on your mineral, and everything the assistant reads and writes stays there with them. Your providers, the hosting company, Anthropic and GitHub, run the server, the model and the backup, and bill you directly. Crads AI writes the software and reaches your machine only through a support session you grant, which is time-boxed and logged.',
    '0 0 824 216', inner);
};

// --- 3. brain, memory, senses ---------------------------------------------------
const brainMemorySenses = () => {
  const id = 'd-bms';
  const inner = [
    box(316, 76, 192, 64, 'Your assistant', 'the mind: Claude, rented', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    box(20, 24, 200, 60, 'Senses', 'mail, calendar, files, Telegram'),
    box(20, 132, 200, 60, 'Memory', 'the brain: pages you own'),
    box(604, 76, 200, 64, 'What it gives you', 'briefs, drafts, answers'),
    arrow(id, 224, 54, 312, 96, 'what it can reach', { lx: 268, ly: 46 }),
    arrow(id, 224, 162, 312, 122, 'what it knows', { lx: 268, ly: 176 }),
    arrow(id, 512, 108, 600, 108, ''),
    arrow(id, 704, 144, 120, 196, 'corrections and captures grow the memory', { d: 'M704 144 C704 214 300 214 224 190', lx: 470, ly: 228 }),
    note(20, 252, 'The mind is rented from Anthropic. The memory and the senses are yours.'),
  ].join('\n');
  return wrap(id, 'Mind, memory, senses',
    'Three parts. Senses, the services it can reach, and memory, the brain of pages you own, both feed the assistant, whose mind is Claude, rented from Anthropic. What it gives you, briefs, drafts and answers, feeds back into the memory when you correct it or capture something. The mind is rented; the memory and the senses are yours.',
    '0 0 824 262', inner);
};

// --- 4. two kinds of memory ---------------------------------------------------
const twoMemories = () => {
  const id = 'd-mem';
  const inner = [
    `<rect x="0" y="20" width="360" height="150" rx="12" fill="${T.main}" stroke="${T.rule}" stroke-dasharray="5 4"/>`,
    eyebrow(16, 42, 'THE CONVERSATION'),
    `<text x="16" y="70" fill="${T.ink}" font-size="13.5" font-weight="600">Short-term</text>`,
    `<text x="16" y="92" fill="${T.soft}" font-size="12.5">Everything said since you opened the Terminal.</text>`,
    `<text x="16" y="110" fill="${T.soft}" font-size="12.5">Fills up. Gone when the session ends.</text>`,
    note(16, 150, 'A closed window forgets. That is normal.'),
    `<rect x="464" y="20" width="360" height="150" rx="12" fill="${T.soft2}" stroke="${T.accent}" stroke-width="1.6"/>`,
    eyebrow(480, 42, 'THE BRAIN', T.accent),
    `<text x="480" y="70" fill="${T.ink}" font-size="13.5" font-weight="600">Long-term</text>`,
    `<text x="480" y="92" fill="${T.soft}" font-size="12.5">Pages it reads before every answer.</text>`,
    `<text x="480" y="110" fill="${T.soft}" font-size="12.5">There in every conversation, forever.</text>`,
    note(480, 150, 'If it forgot, it was never written here.'),
    arrow(id, 364, 70, 460, 70, 'capture', { lx: 412, ly: 58 }),
    arrow(id, 364, 130, 460, 130, 'ingest', { lx: 412, ly: 152 }),
    note(0, 194, 'Capture writes a moment down. Ingest brings a source in. Both land on the right.'),
  ].join('\n');
  return wrap(id, 'Two kinds of memory',
    'Two boxes. On the left the conversation: short-term, everything said since the Terminal was opened, which fills up and is gone when the session ends. On the right the brain: long-term, pages the assistant reads before every answer, there in every conversation. Two arrows carry things from left to right: capture, which writes a moment down, and ingest, which brings a source in. If the assistant forgot something, it was never written into the brain.',
    '0 0 824 204', inner);
};

// --- 5. the CRIT method --------------------------------------------------------
const critFourSteps = () => {
  const id = 'd-crit';
  const y = 40;
  const inner = [
    box(0, y, 176, 62, 'Context', 'what it needs to know'),
    arrow(id, 180, y + 31, 212, y + 31),
    box(216, y, 176, 62, 'Role', 'who you want answering'),
    arrow(id, 396, y + 31, 428, y + 31),
    box(432, y, 176, 62, 'Interview', 'it asks before it answers', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 612, y + 31, 644, y + 31),
    box(648, y, 176, 62, 'Task', 'the outcome and its shape'),
    arrow(id, 520, y + 66, 520, y + 66, 'one question at a time, until it has enough', { d: 'M560 104 C600 150 460 150 500 104', lx: 520, ly: 152, stroke: T.accent }),
    note(0, 132, 'Skip the interview for a quick question. Never skip it for a decision.'),
  ].join('\n');
  return wrap(id, 'The CRIT method',
    'Four boxes left to right: context, what it needs to know; role, who you want answering; interview, where it asks you questions before it answers; task, the outcome and its shape. The interview box is highlighted with a loop, one question at a time until it has enough. A note says to skip the interview for a quick question and never for a decision.',
    '0 0 824 160', inner);
};

// --- 6. a day with your assistant ---------------------------------------------
const dayLoop = () => {
  const id = 'd-day';
  const y = 46;
  const inner = [
    box(0, y, 170, 60, 'Morning', 'the brief arrives'),
    arrow(id, 174, y + 30, 206, y + 30),
    box(210, y, 170, 60, 'The day', 'ask, draft, decide'),
    arrow(id, 384, y + 30, 416, y + 30),
    box(420, y, 170, 60, 'Close', 'capture what happened'),
    arrow(id, 594, y + 30, 626, y + 30),
    box(630, y, 194, 60, 'The memory grew', 'a page or two richer', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 0, 0, 0, 0, 'tomorrow is sharper than today', { d: 'M727 110 C727 156 85 156 85 112', lx: 406, ly: 166, dash: '4 4' }),
  ].join('\n');
  return wrap(id, 'A day with your assistant',
    'Four boxes in a row: morning, when the brief arrives; the day, when you ask, it drafts and you decide; close, when you capture what happened; and the memory grew, a page or two richer. A dashed arrow runs from the last box back to the first: tomorrow is sharper than today because the memory grew.',
    '0 0 824 180', inner);
};

// --- 7. from recipe to skill --------------------------------------------------
const recipeToSkill = () => {
  const id = 'd-recipe';
  const y = 40;
  const inner = [
    box(0, y, 186, 62, 'You describe it', 'in the Terminal, plainly'),
    arrow(id, 190, y + 31, 222, y + 31),
    box(226, y, 186, 62, 'It writes the skill', 'a folder in your brain'),
    arrow(id, 416, y + 31, 448, y + 31),
    box(452, y, 176, 62, 'You run it', 'type /name', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 632, y + 31, 664, y + 31),
    box(668, y, 156, 62, 'Schedule it', 'the Skills page'),
    note(0, 132, 'Marked "yours" on the Skills page, next to the ones the mineral shipped with.'),
  ].join('\n');
  return wrap(id, 'From recipe to skill',
    'Four boxes left to right: you describe the recipe in the Terminal in plain words; it writes the skill as a folder in your brain; you run it by typing its name with a slash; you give it a schedule on the Skills page. A note says the skill is marked yours on the Skills page, next to the ones the mineral shipped with.',
    '0 0 824 146', inner);
};

// --- 8. the week's rhythm -----------------------------------------------------
const weekRhythm = () => {
  const id = 'd-week';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const x0 = 20; const step = 112;
  const inner = [
    `<path d="M${x0} 60 L${x0 + step * 6 + 60} 60" stroke="${T.rule}" stroke-width="2"/>`,
    ...days.map((d, i) => `<text x="${x0 + step * i + 30}" y="44" text-anchor="middle" fill="${T.faint}" font-size="11.5" letter-spacing="0.06em">${d.toUpperCase()}</text>`
      + `<circle cx="${x0 + step * i + 30}" cy="60" r="5" fill="${i === 0 || i === 6 ? T.accent : T.main}" stroke="${T.rule}" stroke-width="1.4"/>`),
    box(x0, 84, 104, 50, 'Plan the week', 'three outcomes', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    box(x0 + step * 1 - 8, 84, 104 + step * 3 + 16, 50, 'Every morning: triage, then the brief', 'every evening: capture'),
    box(x0 + step * 6 - 22, 84, 126, 50, 'Weekly review', 'what moved', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    arrow(id, 0, 0, 0, 0, 'the week is a closed loop', { d: `M${x0 + step * 6 + 40} 138 C${x0 + step * 6 + 40} 172 ${x0 + 52} 172 ${x0 + 52} 140`, lx: x0 + step * 3 + 30, ly: 182, dash: '4 4' }),
  ].join('\n');
  return wrap(id, 'The week, on a schedule',
    'A Monday to Sunday timeline. Monday opens with plan the week, three outcomes. Tuesday to Friday carry the daily rhythm: triage then the brief every morning, capture every evening. Sunday closes with the weekly review of what moved. A dashed arrow runs from Sunday back to Monday: the week is a closed loop.',
    '0 0 824 196', inner);
};

// --- 9. the trust ladder ------------------------------------------------------
const trustLadder = () => {
  const id = 'd-trust';
  const inner = [
    band(30, 20, 794, 54, 'Read', 'it looks, it tells you what it found, it changes nothing', 'where every new connection starts'),
    band(30, 84, 794, 54, 'Draft', 'it writes the email, the page, the plan; you press send', 'where the built-in skills live', { fill: T.card }),
    band(30, 148, 794, 54, 'Act', 'it does the thing without asking first', 'only jobs you moved up, one at a time', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    arrow(id, 0, 0, 0, 0, '', { d: 'M12 196 L12 30', stroke: T.accent }),
    note(30, 228, 'You move a job up the ladder. It never moves itself.'),
  ].join('\n');
  return wrap(id, 'The trust ladder',
    'Three bands stacked top to bottom: read, where it looks and tells you what it found and changes nothing, which is where every new connection starts; draft, where it writes the email or the page and you press send, which is where the built-in skills live; act, where it does the thing without asking first, only for what you have moved up there, one job at a time. A note says you move a job up the ladder and it never moves itself.',
    '0 0 824 244', inner);
};

// --- 10. known unknowns -------------------------------------------------------
const knownUnknowns = () => {
  const id = 'd-ku';
  const cell = (x, y, label, sub, opts) => box(x, y, 350, 76, label, sub, opts);
  const side = (y, text, color) => `<text transform="translate(18 ${y}) rotate(-90)" text-anchor="middle" fill="${color}" font-size="11.5" letter-spacing="0.06em">${text}</text>`;
  const inner = [
    eyebrow(100, 18, 'IT KNOWS'),
    eyebrow(474, 18, 'IT DOES NOT KNOW'),
    side(66, 'YOU KNOW', T.faint),
    side(154, 'YOU DO NOT', T.accent),
    cell(100, 28, 'Ask it', 'the everyday: what is on today, who owes me a reply'),
    cell(474, 28, 'Tell it', 'correct the brief, capture the decision, paste the document', { fill: T.card }),
    cell(100, 116, 'Make it interview you', 'the grill: it asks, you answer, a page fills up', { fill: T.card }),
    cell(474, 116, 'Make it argue with you', 'the council and the negative-space audit', { stroke: T.accent, fill: T.cardHi, strokeWidth: 1.6 }),
  ].join('\n');
  return wrap(id, 'Known and unknown, on both sides',
    'A two by two grid. Columns: what it knows, what it does not know. Rows: what you know, what you do not know. Top left, ask it, the everyday questions. Top right, tell it: correct the brief, capture the decision, paste the document. Bottom left, make it interview you: it asks, you answer, a page fills up. Bottom right, highlighted, make it argue with you: the council and the negative-space audit, for what neither of you has named yet.',
    '0 0 824 204', inner);
};

// --- 11. ask, skill, recipe, or page ------------------------------------------
const askSkillRecipePage = () => {
  const id = 'd-ask';
  const q = (x, y, text) => `<g><rect x="${x}" y="${y}" width="250" height="46" rx="23" fill="${T.main}" stroke="${T.rule}"/>`
    + `<text x="${x + 125}" y="${y + 23}" text-anchor="middle" dominant-baseline="middle" fill="${T.ink}" font-size="13" font-weight="600">${text}</text></g>`;
  const inner = [
    q(0, 10, 'Do you want it once?'),
    arrow(id, 254, 33, 300, 33, 'yes'),
    box(304, 10, 150, 46, 'Ask it', 'in the Terminal'),
    arrow(id, 125, 60, 125, 84, 'no', { lx: 140, ly: 76, anchor: 'start' }),
    q(0, 88, 'Again, the same way, on a day?'),
    arrow(id, 254, 111, 300, 111, 'yes'),
    box(304, 88, 150, 46, 'A skill', 'saved, scheduled'),
    arrow(id, 125, 138, 125, 162, 'no', { lx: 140, ly: 154, anchor: 'start' }),
    q(0, 166, 'Do you want to see it daily?'),
    arrow(id, 254, 189, 300, 189, 'yes'),
    box(304, 166, 150, 46, 'A page or card', 'on your dashboard', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 125, 216, 125, 240, 'no', { lx: 140, ly: 232, anchor: 'start' }),
    box(0, 244, 250, 46, 'Then it is a conversation', 'and a capture at the end'),
    note(470, 40, 'Most things are the first row.'),
    note(470, 118, 'The rule of two: the third time, save it.'),
    note(470, 196, 'Build it with /dashboard.'),
  ].join('\n');
  return wrap(id, 'Ask, skill, or page',
    'A short decision ladder. Do you want it once? Yes: ask it in the Terminal. No: again, the same way, on a day? Yes: a skill, saved and scheduled. No: do you want to see it daily? Yes: a page or a card on your dashboard, built with the dashboard skill. No: then it is a conversation, with a capture at the end. Notes: most things are the first row; the rule of two says the third time, save it.',
    '0 0 824 300', inner);
};

// --- 12. the three layers -----------------------------------------------------
const threeLayers = () => {
  const id = 'd-layers';
  const inner = [
    band(0, 16, 824, 60, 'Your pages', 'the brain, your skills, your dashboard: everything the interview and your corrections made', 'you edit; we never touch', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    band(0, 86, 824, 60, 'Your infrastructure', 'the server, its keys, its backup target, the accounts it signs in with', 'yours; the wizard set it up once', { fill: T.card }),
    band(0, 156, 824, 60, 'The machinery', 'the engine, the built-in skills, the app', 'we maintain; it updates itself nightly'),
    note(0, 240, 'An update replaces the bottom band and leaves the two above it exactly as they were.'),
  ].join('\n');
  return wrap(id, 'Who edits what',
    'Three bands stacked top to bottom. Your pages, the brain, your skills and your dashboard, which you edit and we never touch. Your infrastructure, the server, its keys, its backup target and the accounts it signs in with, which is yours and which the wizard set up once. The machinery, the engine, the built-in skills and the app, which we maintain and which updates itself nightly. A note says an update replaces the bottom band and leaves the two above it exactly as they were.',
    '0 0 824 254', inner);
};

export const DIAGRAMS = {
  'self-host-path': selfHostPath,
  'who-sees-what': whoSees,
  'brain-memory-senses': brainMemorySenses,
  'two-memories': twoMemories,
  'crit-four-steps': critFourSteps,
  'day-loop': dayLoop,
  'recipe-to-skill': recipeToSkill,
  'week-rhythm': weekRhythm,
  'trust-ladder': trustLadder,
  'known-unknowns': knownUnknowns,
  'ask-skill-recipe-page': askSkillRecipePage,
  'three-layers': threeLayers,
};

export const diagramIds = () => Object.keys(DIAGRAMS);
export const renderDiagram = (id) => (DIAGRAMS[id] ? DIAGRAMS[id]() : null);
