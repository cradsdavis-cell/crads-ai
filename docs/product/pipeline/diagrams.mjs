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

// TWO DRAWINGS PER DIAGRAM: WIDE AND NARROW (2026-10-13). A diagram drawn 824
// units wide renders at about 340px on a phone, which shrank its 11.5-unit
// labels to under 5px: unreadable. So every diagram also carries a narrow
// drawing (360 units wide, stacked top to bottom) and a scoped rule shows
// exactly one of the two. The hidden one is display:none, so a screen reader
// meets one title and one description, never two. The narrow drawing carries
// its own ids (`<id>-n`) because two SVGs on one page cannot share them.
// When you change what a diagram SAYS, change both drawings.

// 1080 matches shell.mjs: at or below it the contents column is gone and the
// article is too narrow for the wide drawing's labels (about 8px at 768 to 1024),
// so the stacked drawing shows, capped at 520px so it does not balloon.
const NARROW_AT = 1080; // px of viewport; at or below this the narrow drawing shows
const SWITCH = `<style>figure.diagram svg.dgm-n{display:none!important}`
  + `@media (max-width:${NARROW_AT}px){figure.diagram svg.dgm-w{display:none!important}figure.diagram svg.dgm-n{display:block!important;max-width:520px;margin:0 auto}}</style>`;

const svg = (id, cls, title, desc, vb, inner) => `<svg viewBox="${vb}" role="img" aria-labelledby="${id}-t ${id}-d" class="dgm ${cls}">
<title id="${id}-t">${title}</title><desc id="${id}-d">${desc}</desc>
<defs><marker id="${id}-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0.5 L7.5 4 L0 7.5 z" fill="${T.faint}"/></marker></defs>
${inner}
</svg>`;

// wide = { vb, inner }, narrow = { vb, inner } (narrow drawn with id + '-n').
const wrap = (id, title, desc, wide, narrow) => `<figure class="diagram">
${SWITCH}
${svg(id, 'dgm-w', title, desc, wide.vb, wide.inner)}
${svg(`${id}-n`, 'dgm-n', title, desc, narrow.vb, narrow.inner)}
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

// Several italic lines, 15 units apart.
const notes = (x, y, lines, anchor = 'start') => lines.map((t, i) => note(x, y + i * 15, t, anchor)).join('');

const eyebrow = (x, y, text, color = T.faint) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="11.5" letter-spacing="0.06em">${text}</text>`;

// A wide horizontal band with a label at left and a right-hand annotation.
const band = (x, y, w, h, label, sub, right, opts = {}) => [
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${opts.fill || T.soft2}" stroke="${opts.stroke || T.rule}" stroke-width="${opts.strokeWidth || 1}"/>`,
  `<text x="${x + 18}" y="${y + h / 2 - (sub ? 8 : 0)}" dominant-baseline="middle" fill="${T.ink}" font-size="14" font-weight="600">${label}</text>`,
  sub ? `<text x="${x + 18}" y="${y + h / 2 + 11}" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">${sub}</text>` : '',
  right ? `<text x="${x + w - 18}" y="${y + h / 2}" dominant-baseline="middle" text-anchor="end" fill="${opts.rightColor || T.accentDeep}" font-size="12.5" font-weight="600">${right}</text>` : '',
].join('');

// The narrow band: label, sub, then the annotation on its own third line.
const bandN = (x, y, w, label, sub, right, opts = {}) => [
  `<rect x="${x}" y="${y}" width="${w}" height="70" rx="10" fill="${opts.fill || T.soft2}" stroke="${opts.stroke || T.rule}" stroke-width="${opts.strokeWidth || 1}"/>`,
  `<text x="${x + 14}" y="${y + 20}" dominant-baseline="middle" fill="${T.ink}" font-size="14" font-weight="600">${label}</text>`,
  `<text x="${x + 14}" y="${y + 38}" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">${sub}</text>`,
  `<text x="${x + 14}" y="${y + 56}" dominant-baseline="middle" fill="${opts.rightColor || T.accentDeep}" font-size="12.5" font-weight="600">${right}</text>`,
].join('');

// A top-to-bottom chain of boxes joined by down arrows. Returns the markup and
// the y just below the last box, so a narrow drawing can keep stacking.
const vchain = (id, x, y, w, h, gap, items) => {
  let out = ''; let cy = y;
  items.forEach(([label, sub, opts], i) => {
    if (i) out += arrow(id, x + w / 2, cy - gap + 2, x + w / 2, cy - 3);
    out += box(x, cy, w, h, label, sub, opts);
    cy += h + gap;
  });
  return { svg: out, end: cy - gap };
};

const HI = { stroke: T.accent, fill: T.card, strokeWidth: 1.6 };
const HI2 = { stroke: T.accent, fill: T.cardHi, strokeWidth: 1.6 };

// --- 1. how a mineral comes to exist and becomes yours (self-host era) ---------
const selfHostPath = () => {
  const id = 'd-path';
  const y = 54;
  const wide = [
    eyebrow(0, 18, 'ABOUT FIFTEEN MINUTES'),
    eyebrow(452, 18, 'ABOUT AN HOUR', T.accent),
    box(0, y, 128, 56, 'Your token', 'your own account'),
    arrow(id, 132, y + 28, 168, y + 28),
    box(172, y, 128, 56, 'Built', 'a server exists'),
    arrow(id, 304, y + 28, 340, y + 28),
    box(344, y, 128, 56, 'Open it', 'the app connects'),
    arrow(id, 476, y + 28, 512, y + 28),
    box(516, y, 128, 56, 'Wake it', 'sign in to Claude', HI),
    arrow(id, 648, y + 28, 684, y + 28),
    box(688, y, 132, 56, 'The interview', 'it builds a brain', HI2),
    `<path d="M508 40 L508 148" stroke="${T.accent}" stroke-width="1" stroke-dasharray="3 4" fill="none" opacity="0.6"/>`,
    note(0, 138, 'Built in your hosting account, with your key as the only key on it.'),
    note(516, 138, 'Inert until this. Awake once it knows you.'),
  ].join('\n');
  const n = `${id}-n`;
  const a = vchain(n, 0, 26, 360, 48, 24, [
    ['Your token', 'your own account'], ['Built', 'a server exists'], ['Open it', 'the app connects'],
  ]);
  const b = vchain(n, 0, 304, 360, 48, 24, [
    ['Wake it', 'sign in to Claude', HI], ['The interview', 'it builds a brain', HI2],
  ]);
  const narrow = [
    eyebrow(0, 14, 'ABOUT FIFTEEN MINUTES'),
    a.svg,
    notes(0, 236, ['Built in your hosting account, with your key', 'as the only key on it.']),
    `<path d="M0 268 L360 268" stroke="${T.accent}" stroke-width="1" stroke-dasharray="3 4" fill="none" opacity="0.6"/>`,
    eyebrow(0, 290, 'ABOUT AN HOUR', T.accent),
    b.svg,
    notes(0, b.end + 22, ['Inert until Claude is signed in.', 'Awake once it knows you.']),
  ].join('\n');
  return wrap(id, 'How a mineral becomes yours',
    'Five steps: your own hosting token, a server built in your own account, the app opening it, waking it by signing in to Claude on your own subscription, and the interview that gives it a brain. The first three take about fifteen minutes; the last two about an hour. The server carries only your key from its first boot, and it is inert until Claude is signed in.',
    { vb: '0 0 824 152', inner: wide }, { vb: `0 0 360 ${b.end + 46}`, inner: narrow });
};

// --- 2. who can see what (self-host era) --------------------------------------
// 2026-10-13: the old line under the mineral read "None of this leaves the
// machine". Not true and not allowed: every question goes to Claude, and the
// brain is backed up to the owner's GitHub. It now says where things live.
const whoSees = () => {
  const id = 'd-sees';
  const wide = [
    `<rect x="0" y="28" width="330" height="184" rx="12" fill="${T.soft2}" stroke="${T.rule}"/>`,
    eyebrow(16, 50, 'YOUR MINERAL'),
    box(16, 62, 132, 52, 'Your brain', 'pages, notes'),
    box(160, 62, 154, 52, 'Your credentials', 'keys and tokens'),
    box(16, 126, 298, 46, 'Everything your assistant reads and writes'),
    `<text x="16" y="196" fill="${T.accent}" font-size="12" font-weight="600">Kept on a server in your own account.</text>`,
    box(452, 34, 176, 52, 'Your providers', 'host, Anthropic, GitHub'),
    box(452, 130, 176, 52, 'Crads AI', 'writes the software'),
    arrow(id, 338, 60, 446, 60, 'you pay them directly', { lx: 388, ly: 46 }),
    arrow(id, 446, 156, 338, 156, 'only if you let us in', { lx: 392, ly: 174, dash: '4 4' }),
    note(452, 104, 'They run the server, the thinking, the backup.'),
    note(452, 200, 'Never otherwise. Time-boxed, and logged.'),
  ].join('\n');
  const n = `${id}-n`;
  const narrow = [
    `<rect x="0" y="0" width="360" height="168" rx="12" fill="${T.soft2}" stroke="${T.rule}"/>`,
    eyebrow(12, 20, 'YOUR MINERAL'),
    box(12, 30, 162, 50, 'Your brain', 'pages, notes'),
    box(186, 30, 162, 50, 'Your credentials', 'keys and tokens'),
    box(12, 90, 336, 42, 'Everything your assistant reads and writes'),
    `<text x="12" y="154" fill="${T.accent}" font-size="12" font-weight="600">Kept on a server in your own account.</text>`,
    arrow(n, 87, 172, 87, 204),
    arrow(n, 273, 204, 273, 172, '', { dash: '4 4' }),
    box(0, 208, 174, 50, 'Your providers', 'host, Anthropic, GitHub'),
    box(186, 208, 174, 50, 'Crads AI', 'writes the software'),
    notes(0, 278, ['You pay them directly.', 'They run the server,', 'the thinking, the backup.']),
    notes(186, 278, ['Only if you let us in.', 'Time-boxed, and logged.']),
  ].join('\n');
  return wrap(id, 'Who can see what',
    'Your brain and your credentials live on your mineral, a server in your own account, with everything the assistant reads and writes. Your providers, the hosting company, Anthropic and GitHub, run the server, the thinking and the backup, and you pay them directly. Crads AI writes the software and reaches your machine only through a support session you grant, which is time-boxed and logged.',
    { vb: '0 0 824 216', inner: wide }, { vb: '0 0 360 314', inner: narrow });
};

// --- 3. brain, memory, senses ---------------------------------------------------
const brainMemorySenses = () => {
  const id = 'd-bms';
  const wide = [
    box(316, 76, 192, 64, 'Your assistant', 'the mind: Claude, rented', HI),
    box(20, 24, 200, 60, 'Senses', 'mail, calendar, files, Telegram'),
    box(20, 132, 200, 60, 'Memory', 'the brain: pages you own'),
    box(604, 76, 200, 64, 'What it gives you', 'briefs, drafts, answers'),
    arrow(id, 224, 54, 312, 96, 'what it can reach', { lx: 268, ly: 46 }),
    arrow(id, 224, 162, 312, 122, 'what it knows', { lx: 268, ly: 176 }),
    arrow(id, 512, 108, 600, 108, ''),
    arrow(id, 704, 144, 120, 196, 'corrections and captures grow the memory', { d: 'M704 144 C704 214 300 214 224 190', lx: 470, ly: 228 }),
    note(20, 252, 'The mind is rented from Anthropic. The memory and the senses are yours.'),
  ].join('\n');
  const n = `${id}-n`;
  const narrow = [
    box(0, 0, 170, 54, 'Senses', 'mail, calendar, Telegram'),
    box(190, 0, 170, 54, 'Memory', 'the brain: pages you own'),
    arrow(n, 85, 58, 130, 94),
    arrow(n, 260, 58, 222, 94),
    box(40, 98, 240, 56, 'Your assistant', 'the mind: Claude, rented', HI),
    arrow(n, 160, 158, 160, 186),
    box(40, 190, 240, 54, 'What it gives you', 'briefs, drafts, answers'),
    arrow(n, 0, 0, 0, 0, '', { d: 'M284 217 C344 217 344 92 330 60' }),
    `<text x="180" y="266" text-anchor="middle" fill="${T.faint}" font-size="11.5">corrections and captures grow the memory</text>`,
    notes(0, 296, ['The mind is rented from Anthropic.', 'The memory and the senses are yours.']),
  ].join('\n');
  return wrap(id, 'Mind, memory, senses',
    'Three parts. Senses, the services it can reach, and memory, the brain of pages you own, both feed the assistant, whose mind is Claude, rented from Anthropic. What it gives you, briefs, drafts and answers, feeds back into the memory when you correct it or capture something. The mind is rented; the memory and the senses are yours.',
    { vb: '0 0 824 262', inner: wide }, { vb: '0 0 360 320', inner: narrow });
};

// --- 4. two kinds of memory ---------------------------------------------------
const twoMemories = () => {
  const id = 'd-mem';
  const wide = [
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
  const n = `${id}-n`;
  const narrow = [
    `<rect x="0" y="0" width="360" height="132" rx="12" fill="${T.main}" stroke="${T.rule}" stroke-dasharray="5 4"/>`,
    eyebrow(14, 22, 'THE CONVERSATION'),
    `<text x="14" y="48" fill="${T.ink}" font-size="13.5" font-weight="600">Short-term</text>`,
    `<text x="14" y="70" fill="${T.soft}" font-size="12.5">Everything said since you opened the Terminal.</text>`,
    `<text x="14" y="88" fill="${T.soft}" font-size="12.5">Fills up. Gone when the session ends.</text>`,
    note(14, 116, 'A closed window forgets. That is normal.'),
    arrow(n, 110, 136, 110, 178, 'capture', { lx: 120, ly: 162, anchor: 'start' }),
    arrow(n, 250, 136, 250, 178, 'ingest', { lx: 260, ly: 162, anchor: 'start' }),
    `<rect x="0" y="182" width="360" height="132" rx="12" fill="${T.soft2}" stroke="${T.accent}" stroke-width="1.6"/>`,
    eyebrow(14, 204, 'THE BRAIN', T.accent),
    `<text x="14" y="230" fill="${T.ink}" font-size="13.5" font-weight="600">Long-term</text>`,
    `<text x="14" y="252" fill="${T.soft}" font-size="12.5">Pages it reads before every answer.</text>`,
    `<text x="14" y="270" fill="${T.soft}" font-size="12.5">There in every conversation, forever.</text>`,
    note(14, 298, 'If it forgot, it was never written here.'),
    notes(0, 338, ['Capture writes a moment down. Ingest brings', 'a source in. Both land in the brain.']),
  ].join('\n');
  return wrap(id, 'Two kinds of memory',
    'Two boxes. First the conversation: short-term, everything said since the Terminal was opened, which fills up and is gone when the session ends. Then the brain: long-term, pages the assistant reads before every answer, there in every conversation. Two arrows carry things from the conversation into the brain: capture, which writes a moment down, and ingest, which brings a source in. If the assistant forgot something, it was never written into the brain.',
    { vb: '0 0 824 204', inner: wide }, { vb: '0 0 360 360', inner: narrow });
};

// --- 5. the CRIT method --------------------------------------------------------
const critFourSteps = () => {
  const id = 'd-crit';
  const y = 40;
  const wide = [
    box(0, y, 176, 62, 'Context', 'what it needs to know'),
    arrow(id, 180, y + 31, 212, y + 31),
    box(216, y, 176, 62, 'Role', 'who you want answering'),
    arrow(id, 396, y + 31, 428, y + 31),
    box(432, y, 176, 62, 'Interview', 'it asks before it answers', HI),
    arrow(id, 612, y + 31, 644, y + 31),
    box(648, y, 176, 62, 'Task', 'the outcome and its shape'),
    arrow(id, 520, y + 66, 520, y + 66, 'one question at a time, until it has enough', { d: 'M560 104 C600 150 460 150 500 104', lx: 520, ly: 152, stroke: T.accent }),
    note(0, 132, 'Skip the interview for a quick question. Never skip it for a decision.'),
  ].join('\n');
  const n = `${id}-n`;
  const c = vchain(n, 0, 0, 290, 50, 22, [
    ['Context', 'what it needs to know'], ['Role', 'who you want answering'],
    ['Interview', 'it asks, one question at a time', HI], ['Task', 'the outcome and its shape'],
  ]);
  const iy = 2 * 72; // the interview box's top
  const narrow = [
    c.svg,
    arrow(n, 0, 0, 0, 0, '', { d: `M294 ${iy + 14} C342 ${iy + 6} 342 ${iy + 44} 296 ${iy + 36}`, stroke: T.accent }),
    notes(0, c.end + 24, ['Skip the interview for a quick question.', 'Never skip it for a decision.']),
  ].join('\n');
  return wrap(id, 'The CRIT method',
    'Four steps in order: context, what it needs to know; role, who you want answering; interview, where it asks you questions before it answers; task, the outcome and its shape. The interview is highlighted with a loop, one question at a time until it has enough. A note says to skip the interview for a quick question and never for a decision.',
    { vb: '0 0 824 160', inner: wide }, { vb: `0 0 360 ${c.end + 46}`, inner: narrow });
};

// --- 6. a day with your assistant ---------------------------------------------
const dayLoop = () => {
  const id = 'd-day';
  const y = 46;
  const wide = [
    box(0, y, 170, 60, 'Morning', 'the brief arrives'),
    arrow(id, 174, y + 30, 206, y + 30),
    box(210, y, 170, 60, 'The day', 'ask, draft, decide'),
    arrow(id, 384, y + 30, 416, y + 30),
    box(420, y, 170, 60, 'Close', 'capture what happened'),
    arrow(id, 594, y + 30, 626, y + 30),
    box(630, y, 194, 60, 'The memory grew', 'a page or two richer', HI),
    arrow(id, 0, 0, 0, 0, 'tomorrow is sharper than today', { d: 'M727 110 C727 156 85 156 85 112', lx: 406, ly: 166, dash: '4 4' }),
  ].join('\n');
  const n = `${id}-n`;
  const c = vchain(n, 0, 0, 290, 50, 22, [
    ['Morning', 'the brief arrives'], ['The day', 'ask, draft, decide'],
    ['Close', 'capture what happened'], ['The memory grew', 'a page or two richer', HI],
  ]);
  const narrow = [
    c.svg,
    arrow(n, 0, 0, 0, 0, '', { d: `M294 ${3 * 72 + 25} C350 ${3 * 72 + 25} 350 25 296 25`, dash: '4 4' }),
    note(0, c.end + 24, 'Tomorrow is sharper than today.'),
  ].join('\n');
  return wrap(id, 'A day with your assistant',
    'Four steps in a loop: morning, when the brief arrives; the day, when you ask, it drafts and you decide; close, when you capture what happened; and the memory grew, a page or two richer. A dashed arrow runs from the last step back to the first: tomorrow is sharper than today because the memory grew.',
    { vb: '0 0 824 180', inner: wide }, { vb: `0 0 360 ${c.end + 34}`, inner: narrow });
};

// --- 7. from recipe to skill --------------------------------------------------
const recipeToSkill = () => {
  const id = 'd-recipe';
  const y = 40;
  const wide = [
    box(0, y, 186, 62, 'You describe it', 'in the Terminal, plainly'),
    arrow(id, 190, y + 31, 222, y + 31),
    box(226, y, 186, 62, 'It writes the skill', 'a folder in your brain'),
    arrow(id, 416, y + 31, 448, y + 31),
    box(452, y, 176, 62, 'You run it', 'type /name', HI),
    arrow(id, 632, y + 31, 664, y + 31),
    box(668, y, 156, 62, 'Schedule it', 'the Skills page'),
    note(0, 132, 'Labelled "yours" on the Skills page, next to the ones the mineral shipped with.'),
  ].join('\n');
  const n = `${id}-n`;
  const c = vchain(n, 0, 0, 360, 50, 22, [
    ['You describe it', 'in the Terminal, plainly'], ['It writes the skill', 'a folder in your brain'],
    ['You run it', 'type /name', HI], ['Schedule it', 'the Skills page'],
  ]);
  const narrow = [
    c.svg,
    notes(0, c.end + 24, ['Labelled "yours" on the Skills page, next to', 'the ones the mineral shipped with.']),
  ].join('\n');
  return wrap(id, 'From recipe to skill',
    'Four steps in order: you describe the recipe in the Terminal in plain words; it writes the skill as a folder in your brain; you run it by typing its name with a slash; you give it a schedule on the Skills page. A note says the skill is labelled yours on the Skills page, next to the ones the mineral shipped with.',
    { vb: '0 0 824 146', inner: wide }, { vb: `0 0 360 ${c.end + 46}`, inner: narrow });
};

// --- 8. the week's rhythm -----------------------------------------------------
const weekRhythm = () => {
  const id = 'd-week';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const x0 = 20; const step = 112;
  const wide = [
    `<path d="M${x0} 60 L${x0 + step * 6 + 60} 60" stroke="${T.rule}" stroke-width="2"/>`,
    ...days.map((d, i) => `<text x="${x0 + step * i + 30}" y="44" text-anchor="middle" fill="${T.faint}" font-size="11.5" letter-spacing="0.06em">${d.toUpperCase()}</text>`
      + `<circle cx="${x0 + step * i + 30}" cy="60" r="5" fill="${i === 0 || i === 6 ? T.accent : T.main}" stroke="${T.rule}" stroke-width="1.4"/>`),
    box(x0, 84, 104, 50, 'Plan the week', 'three outcomes', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    box(x0 + step * 1 - 2, 84, 104 + step * 3 + 4, 50, 'Every morning: triage, then the brief', 'every evening: capture'),
    box(x0 + step * 6 - 22, 84, 126, 50, 'Weekly review', 'what moved', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    arrow(id, 0, 0, 0, 0, 'the week is a closed loop', { d: `M${x0 + step * 6 + 40} 138 C${x0 + step * 6 + 40} 172 ${x0 + 52} 172 ${x0 + 52} 140`, lx: x0 + step * 3 + 30, ly: 182, dash: '4 4' }),
  ].join('\n');
  const n = `${id}-n`;
  const rs = 44; const ry = (i) => 24 + rs * i; // row centre for each day
  const narrow = [
    `<path d="M40 ${ry(0)} L40 ${ry(6)}" stroke="${T.rule}" stroke-width="2"/>`,
    ...days.map((d, i) => `<text x="0" y="${ry(i)}" dominant-baseline="middle" fill="${T.faint}" font-size="11.5" letter-spacing="0.06em">${d.toUpperCase()}</text>`
      + `<circle cx="40" cy="${ry(i)}" r="5" fill="${i === 0 || i === 6 ? T.accent : T.main}" stroke="${T.rule}" stroke-width="1.4"/>`),
    box(60, ry(0) - 20, 244, 40, 'Plan the week', 'three outcomes', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    `<g><rect x="60" y="${ry(1) - 18}" width="244" height="${rs * 3 + 36}" rx="9" fill="${T.soft2}" stroke="${T.rule}"/>`
      + `<text x="182" y="${ry(2) + 4}" text-anchor="middle" dominant-baseline="middle" fill="${T.ink}" font-size="13.5" font-weight="600">Every morning</text>`
      + `<text x="182" y="${ry(2) + 24}" text-anchor="middle" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">triage, then the brief</text>`
      + `<text x="182" y="${ry(3) + 4}" text-anchor="middle" dominant-baseline="middle" fill="${T.faint}" font-size="11.5">every evening: capture</text></g>`,
    box(60, ry(6) - 20, 244, 40, 'Weekly review', 'what moved', { stroke: T.accent, fill: T.card, strokeWidth: 1.4 }),
    arrow(n, 0, 0, 0, 0, '', { d: `M308 ${ry(6)} C352 ${ry(6)} 352 ${ry(0)} 310 ${ry(0)}`, dash: '4 4' }),
    note(0, ry(6) + 46, 'The week is a closed loop.'),
  ].join('\n');
  return wrap(id, 'The week, on a schedule',
    'A Monday to Sunday timeline. Monday opens with plan the week, three outcomes. Tuesday to Friday carry the daily rhythm: triage then the brief every morning, capture every evening. Sunday closes with the weekly review of what moved. A dashed arrow runs from Sunday back to Monday: the week is a closed loop.',
    { vb: '0 0 824 196', inner: wide }, { vb: `0 0 360 ${ry(6) + 56}`, inner: narrow });
};

// --- 9. the trust ladder ------------------------------------------------------
// 2026-10-13: the rungs used to run read, draft, act from the top down while the
// arrow pointed up, so "move a job up the ladder" pointed at read. Act is now at
// the top, read at the foot, and the arrow climbs.
const trustLadder = () => {
  const id = 'd-trust';
  const wide = [
    band(30, 20, 794, 54, 'Act', 'it does the thing without asking first', 'only jobs you moved up, one at a time', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    band(30, 84, 794, 54, 'Draft', 'it writes the email, the page, the plan; you press send', 'where the built-in skills live', { fill: T.card }),
    band(30, 148, 794, 54, 'Read', 'it looks, it tells you what it found, it changes nothing', 'start every new connection here'),
    arrow(id, 0, 0, 0, 0, '', { d: 'M12 196 L12 30', stroke: T.accent }),
    note(30, 228, 'You move a job up the ladder. It never moves itself.'),
  ].join('\n');
  const n = `${id}-n`;
  const narrow = [
    bandN(24, 0, 336, 'Act', 'it does the thing without asking first', 'only jobs you moved up, one at a time', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    bandN(24, 80, 336, 'Draft', 'it writes it; you press send', 'where the built-in skills live', { fill: T.card }),
    bandN(24, 160, 336, 'Read', 'it looks and reports; it changes nothing', 'start every new connection here'),
    arrow(n, 0, 0, 0, 0, '', { d: 'M8 226 L8 10', stroke: T.accent }),
    notes(0, 256, ['You move a job up the ladder.', 'It never moves itself.']),
  ].join('\n');
  return wrap(id, 'The trust ladder',
    'Three rungs, climbed from the bottom. Read, at the foot: it looks, tells you what it found and changes nothing, which is where to start every new connection. Draft, in the middle: it writes the email or the page and you press send, which is where the built-in skills live. Act, at the top: it does the thing without asking first, only for jobs you have moved up there, one at a time. An arrow climbs the side, and a note says you move a job up the ladder and it never moves itself.',
    { vb: '0 0 824 244', inner: wide }, { vb: '0 0 360 280', inner: narrow });
};

// --- 10. known unknowns -------------------------------------------------------
// 2026-10-13: the cells now follow the grid. The old bottom-left (it knows, you
// do not) held the grill, which is the opposite case: the grill gets what YOU
// know onto a page. The grill joined "tell it", and the bottom-left became the
// page's two "ask it what it sees" sections.
const KU = [
  ['Ask it', 'the everyday: what is on today, what we agreed', 'YOU KNOW, IT KNOWS', 'the everyday questions'],
  ['Tell it, or let it interview you', 'correct the brief, capture the decision, the grill', 'YOU KNOW, IT DOES NOT', 'correct it, capture it, the grill'],
  ['Ask it what it sees', 'audit your skills, ask it about itself', 'IT KNOWS, YOU DO NOT', 'audit your skills, ask about itself'],
  ['Make it argue with you', 'the council and the negative-space audit', 'NEITHER OF YOU KNOWS', 'the council, the negative-space audit'],
];
const knownUnknowns = () => {
  const id = 'd-ku';
  const cell = (x, y, label, sub, opts) => box(x, y, 350, 76, label, sub, opts);
  const side = (y, text, color) => `<text transform="translate(18 ${y}) rotate(-90)" text-anchor="middle" fill="${color}" font-size="11.5" letter-spacing="0.06em">${text}</text>`;
  const opts = [undefined, { fill: T.card }, { fill: T.card }, HI2];
  const wide = [
    eyebrow(100, 18, 'IT KNOWS'),
    eyebrow(474, 18, 'IT DOES NOT KNOW'),
    side(66, 'YOU KNOW', T.faint),
    side(154, 'YOU DO NOT', T.accent),
    cell(100, 28, KU[0][0], KU[0][1], opts[0]),
    cell(474, 28, KU[1][0], KU[1][1], opts[1]),
    cell(100, 116, KU[2][0], KU[2][1], opts[2]),
    cell(474, 116, KU[3][0], KU[3][1], opts[3]),
  ].join('\n');
  const narrow = KU.map(([label, , eb, sub], i) => eyebrow(0, 14 + i * 84, eb, i === 3 ? T.accent : T.faint)
    + box(0, 22 + i * 84, 360, 52, label, sub, opts[i])).join('\n');
  return wrap(id, 'Known and unknown, on both sides',
    'A two by two grid. Columns: what it knows, what it does not know. Rows: what you know, what you do not know. You both know: ask it, the everyday questions. You know and it does not: tell it, or let it interview you; correct the brief, capture the decision, or let it grill you until a page fills up. It knows and you do not: ask it what it sees, by auditing your skills or asking it about itself. Neither of you knows, highlighted: make it argue with you, with the council and the negative-space audit.',
    { vb: '0 0 824 204', inner: wide }, { vb: '0 0 360 330', inner: narrow });
};

// --- 11. ask, skill, recipe, or page ------------------------------------------
const askSkillRecipePage = () => {
  const id = 'd-ask';
  const q = (x, y, text, w = 250, h = 46, fs = 13) => `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${T.main}" stroke="${T.rule}"/>`
    + `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" fill="${T.ink}" font-size="${fs}" font-weight="600">${text}</text></g>`;
  const ROWS = [
    ['Do you want it once?', 'Ask it', 'in the Terminal'],
    ['Again, the same way, on a day?', 'A skill', 'saved, scheduled'],
    ['Do you want to see it daily?', 'A page or card', 'on your dashboard'],
  ];
  const wide = [
    q(0, 10, ROWS[0][0]),
    arrow(id, 254, 33, 300, 33, 'yes'),
    box(304, 10, 150, 46, ROWS[0][1], ROWS[0][2]),
    arrow(id, 125, 60, 125, 84, 'no', { lx: 140, ly: 76, anchor: 'start' }),
    q(0, 88, ROWS[1][0]),
    arrow(id, 254, 111, 300, 111, 'yes'),
    box(304, 88, 150, 46, ROWS[1][1], ROWS[1][2]),
    arrow(id, 125, 138, 125, 162, 'no', { lx: 140, ly: 154, anchor: 'start' }),
    q(0, 166, ROWS[2][0]),
    arrow(id, 254, 189, 300, 189, 'yes'),
    box(304, 166, 150, 46, ROWS[2][1], ROWS[2][2], HI),
    arrow(id, 125, 216, 125, 240, 'no', { lx: 140, ly: 232, anchor: 'start' }),
    box(0, 244, 250, 46, 'Then it is a conversation', 'and a capture at the end'),
    note(470, 40, 'Most things are the first row.'),
    note(470, 118, 'The rule of two: the third time, save it.'),
    note(470, 196, 'Build it with /dashboard.'),
  ].join('\n');
  const n = `${id}-n`;
  const rowY = (i) => i * 78;
  const narrow = [
    ...ROWS.map(([qq, a, s], i) => q(0, rowY(i), qq, 214, 42, 12.5)
      + arrow(n, 218, rowY(i) + 21, 238, rowY(i) + 21, 'yes', { lx: 228, ly: rowY(i) + 13 })
      + box(242, rowY(i), 118, 42 + 4, a, s, i === 2 ? HI : undefined)
      + arrow(n, 107, rowY(i) + 46, 107, rowY(i) + 74, 'no', { lx: 118, ly: rowY(i) + 64, anchor: 'start' })),
    box(0, rowY(3), 214, 46, 'Then it is a conversation', 'and a capture at the end'),
    notes(0, rowY(3) + 72, ['Most things are the first row.', 'The rule of two: the third time, save it.', 'Build a page or card with /dashboard.']),
  ].join('\n');
  return wrap(id, 'Ask, skill, or page',
    'A short decision ladder. Do you want it once? Yes: ask it in the Terminal. No: again, the same way, on a day? Yes: a skill, saved and scheduled. No: do you want to see it daily? Yes: a page or a card on your dashboard, built with the dashboard skill. No: then it is a conversation, with a capture at the end. Notes: most things are the first row; the rule of two says the third time, save it.',
    { vb: '0 0 824 300', inner: wide }, { vb: `0 0 360 ${rowY(3) + 112}`, inner: narrow });
};

// --- 12. the three layers -----------------------------------------------------
// 2026-10-13: brought into line with the-three-layers page and
// docs/three-layer-model.md. Skills, schedules and connections are layer 2 (you
// own them), the top band is the dashboard pages, and the machinery is the
// project's, delivered by the nightly restart.
const threeLayers = () => {
  const id = 'd-layers';
  const wide = [
    band(0, 16, 824, 60, 'Your pages', 'the dashboard pages you and your assistant build', 'you edit; an update never overwrites them', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    band(0, 86, 824, 60, 'Your infrastructure', 'your skills and schedules, your connections and their keys, the server', 'yours; no permission needed', { fill: T.card }),
    band(0, 156, 824, 60, 'The machinery', 'the engine, the scheduler, the system pages, the app', 'the project maintains it; nightly restart'),
    note(0, 240, 'An update replaces the bottom band. The two above it, and your brain, stay exactly as they were.'),
  ].join('\n');
  const narrow = [
    bandN(0, 0, 360, 'Your pages', 'the dashboard pages you and your assistant build', 'you edit; an update never overwrites them', { fill: T.cardHi, stroke: T.accent, strokeWidth: 1.4 }),
    bandN(0, 80, 360, 'Your infrastructure', 'skills, schedules, connections, the server', 'yours; no permission needed', { fill: T.card }),
    bandN(0, 160, 360, 'The machinery', 'the engine, the scheduler, system pages, the app', 'the project maintains it; nightly restart'),
    notes(0, 256, ['An update replaces the bottom band. The two', 'above it, and your brain, stay as they were.']),
  ].join('\n');
  return wrap(id, 'Who edits what',
    'Three bands stacked top to bottom. Your pages, the dashboard pages you and your assistant build, which you edit and an update never overwrites. Your infrastructure, your skills and schedules, your connections and their keys, and the server itself, which is yours to change with no permission needed. The machinery, the engine, the scheduler, the system pages and the app, which the project maintains and delivers by a nightly restart. A note says an update replaces the bottom band and leaves the two above it, and your brain, exactly as they were.',
    { vb: '0 0 824 254', inner: wide }, { vb: '0 0 360 280', inner: narrow });
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
