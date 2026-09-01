// diagrams.mjs - inline SVG diagrams, in the site's own design language.
//
// Referenced from a page exactly like a screenshot:  ![alt](diagram:birth-path)
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

const T = {
  ink: 'var(--ink-deep)',
  soft: 'var(--ink-soft)',
  faint: 'var(--ink-faint)',
  rule: 'var(--rule)',
  accent: 'var(--accent)',
  card: 'var(--bg-card)',
  cardHi: 'var(--bg-card-hi)',
  soft2: 'var(--bg-soft)',
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
  return `<g><path d="${d}" fill="none" stroke="${T.faint}" stroke-width="1.4"`
    + `${opts.dash ? ` stroke-dasharray="${opts.dash}"` : ''} marker-end="url(#${id}-a)"/>`
    + (label ? `<text x="${lx}" y="${ly}" text-anchor="${anchor}" fill="${T.faint}" font-size="11.5">${label}</text>` : '')
    + '</g>';
};

const note = (x, y, text, anchor = 'start') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${T.faint}" font-size="11.5" font-style="italic">${text}</text>`;

// --- 1. how a mineral comes to exist and becomes yours -----------------------
const birthPath = () => {
  const id = 'd-birth';
  const y = 54;
  const inner = [
    `<text x="0" y="18" fill="${T.faint}" font-size="11.5" letter-spacing="0.06em">BEFORE YOU TOUCH IT</text>`,
    `<text x="452" y="18" fill="${T.accent}" font-size="11.5" letter-spacing="0.06em">YOURS FROM HERE</text>`,
    box(0, y, 128, 56, 'Asked for', 'by you or your rock'),
    arrow(id, 132, y + 28, 168, y + 28),
    box(172, y, 128, 56, 'Built', 'a machine exists'),
    arrow(id, 304, y + 28, 340, y + 28),
    box(344, y, 128, 56, 'Invited', 'a link, 48 hours'),
    arrow(id, 476, y + 28, 512, y + 28),
    box(516, y, 128, 56, 'Claimed', 'you sign in', { stroke: T.accent, fill: T.card, strokeWidth: 1.6 }),
    arrow(id, 648, y + 28, 684, y + 28),
    box(688, y, 132, 56, 'Awake', 'Claude signed in', { stroke: T.accent, fill: T.cardHi, strokeWidth: 1.6 }),
    `<path d="M508 40 L508 148" stroke="${T.accent}" stroke-width="1" stroke-dasharray="3 4" fill="none" opacity="0.6"/>`,
    note(0, 138, 'Inert. Nothing runs, nothing is read, nobody is watching.'),
    note(516, 138, 'The link stops mattering: your account holds it.'),
  ].join('\n');
  return wrap(id, 'How a mineral becomes yours',
    'Five steps left to right: asked for, built, invited, claimed, awake. The mineral is inert until you claim it by signing in, and the invitation link stops granting anything once your account holds the mineral.',
    '0 0 824 152', inner);
};

// --- 2. who can see what ------------------------------------------------------
const whoSees = () => {
  const id = 'd-sees';
  const inner = [
    `<rect x="0" y="28" width="330" height="184" rx="12" fill="${T.soft2}" stroke="${T.rule}"/>`,
    `<text x="16" y="50" fill="${T.faint}" font-size="11.5" letter-spacing="0.06em">YOUR MINERAL</text>`,
    box(16, 62, 132, 52, 'Your brain', 'pages, notes'),
    box(160, 62, 154, 52, 'Your credentials', 'keys and tokens'),
    box(16, 126, 298, 46, 'Everything your assistant reads and writes'),
    `<text x="16" y="196" fill="${T.accent}" font-size="12" font-weight="600">None of this leaves the machine.</text>`,
    box(452, 34, 176, 52, 'Your rock', 'the community hosting you'),
    box(452, 130, 176, 52, 'Crads AI', 'keeps the software running'),
    // The heartbeat travels OUT: the mineral sends it.
    arrow(id, 338, 82, 446, 62, 'heartbeat only', { lx: 392, ly: 60 }),
    // Support access travels IN: Crads reaches the machine, the machine sends
    // nothing. Drawn right-to-left for that reason. The first version of this
    // diagram pointed it outward, which said the opposite of the page it sits on.
    arrow(id, 446, 152, 338, 152, 'you let us in', { lx: 392, ly: 168, dash: '4 4' }),
    note(452, 104, 'Cannot read your brain.'),
    note(452, 200, 'Only while the grant is live, and logged.'),
  ].join('\n');
  return wrap(id, 'Who can see what',
    'Your brain and credentials stay on your mineral. Your rock receives only a small status heartbeat and cannot read your brain. Crads AI reaches the machine only through a support session you grant, which expires and is logged.',
    '0 0 824 216', inner);
};

// --- 3. the four things ownership.json records --------------------------------
const ownership = () => {
  const id = 'd-own';
  const row = (y, name, means, who) => [
    box(0, y, 150, 44, name, null, { fill: T.card }),
    `<text x="168" y="${y + 18}" fill="${T.ink}" font-size="13">${means}</text>`,
    `<text x="168" y="${y + 34}" fill="${T.faint}" font-size="11.5">${who}</text>`,
  ].join('\n');
  const inner = [
    row(6, 'holder', 'Whose mineral this is', 'A badge. No grant can ever make you this.'),
    row(62, 'owner', 'Who owns it', 'Fails closed to you if it cannot be read.'),
    row(118, 'managed by', 'Who looks after it', 'Status, skills, updates, teardown.'),
    // A gap between the last two rows, because the note that joins them needs
    // somewhere to sit. The first version anchored it to the left of the bracket
    // and it landed on top of the `managed by` box.
    row(198, 'grants', 'Who may read it', 'An intent, until that address signs in.'),
    `<path d="M158 140 L158 220" stroke="${T.accent}" stroke-width="1.6" fill="none"/>`,
    `<path d="M158 140 L166 140 M158 220 L166 220" stroke="${T.accent}" stroke-width="1.6" fill="none"/>`,
    `<text x="174" y="184" fill="${T.accent}" font-size="11.5" font-weight="600">never the same thing</text>`,
  ].join('\n');
  return wrap(id, 'The four things a mineral records about who it belongs to',
    'Four separate records: holder, owner, managed by, and grants. Managing a mineral and being allowed to read it are deliberately different records, and no part of the software may promote one into the other.',
    '0 0 620 250', inner);
};

export const DIAGRAMS = {
  'birth-path': birthPath,
  'who-sees-what': whoSees,
  'ownership-fields': ownership,
};

export const diagramIds = () => Object.keys(DIAGRAMS);
export const renderDiagram = (id) => (DIAGRAMS[id] ? DIAGRAMS[id]() : null);
