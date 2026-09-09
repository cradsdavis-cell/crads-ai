// claims.mjs - what the gates refuse, as data.
//
// Build step 5 of the documentation-system spec. Three kinds of rule, kept
// here rather than inline in the test so that changing what the docs promise
// is a visible, reviewable diff.

// --- vocabulary -------------------------------------------------------------
// Internal wire vocabulary, matched as PHRASES rather than tokens.
//
// The first version banned the bare tokens `stamp`, `wire` and `mark`. Over one
// afternoon of writing it caught "mark-read" (an inbox bucket) in the generated
// skills page, "if you wire it to your business email" in the terms, and "or
// mark anything done" in a recipe how-to. Three false positives, zero real
// leaks. A gate that is wrong every time it fires teaches you to route around
// it, so it was made precise instead of being obeyed.
//
// What actually must not reach a reader is the internal NOUN sense: metal being
// stamped, an anchor wire being claimed, a connector wearing a mark. Ordinary
// English verbs share the tokens and are fine. `mineral` is not here at all:
// Sam ruled 2026-08-24 that it is brand and stays member-facing.
export const BANNED_PHRASES = [
  { id: 'stamp-the-metal', re: /\bstamp(ed|ing|s)?\s+(the\s+|a\s+|its\s+)?(metal|box(es)?|mineral|pebble|rock)\b/i,
    why: 'provisioning sense: a member never stamps anything' },
  { id: 'the-stamp-path', re: /\b(the|a)\s+(door-born\s+)?stamp\s+(path|is|was)\b/i,
    why: 'the birth path as internal machinery vocabulary' },
  { id: 'the-anchor-wire', re: /\b(the|a|its|an)\s+(anchor\s+)?wire\b(?!\s*(less|d\b))/i,
    why: 'the anchor-edge mechanism; internal plumbing' },
  { id: 'wire-bundle', re: /\bwire\s+bundle\b/i, why: 'same mechanism' },
  { id: 'connector-mark', re: /\bmarks?\b[^.]*\bconnector|\bconnector\b[^.]*\bmarks?\b/i,
    why: 'connector-state vocabulary from the panel internals; either word order' },
];

// Kept for the tests that assert the ruling, and for anyone grepping for it.
export const BANNED_TERMS = BANNED_PHRASES;
export const TERM_EXCEPTIONS = [];

// --- pinned claims ----------------------------------------------------------
// Sentences whose disappearance is a trust or legal problem, not a style
// regression. A claim is enforced the moment its page exists; until then it is
// reported, which makes this list double as the writing queue.
export const PINNED_CLAIMS = [
  { id: 'privacy-no-reading', slug: 'privacy-policy', must: 'Nobody at Crads AI reads your notes',
    why: 'the commitment Harriet drafted herself on 2026-07-17; the whole privacy position rests on it' },
  { id: 'privacy-ownership', slug: 'privacy-policy', must: 'your data',
    why: 'member-owns-their-data is the D60 ownership model stated to the member' },
  { id: 'continuity-takeaway', slug: 'continuity', must: 'take the box',
    why: 'Harriet objection 2 (what if you pick up another job): the answer must survive every edit' },
  { id: 'google-byo-key', slug: 'connect-google', must: 'never touches',
    why: 'the member-owned OAuth client is the headline compliance fact, not fine print' },
  // REMOVED 2026-08-24: `whatsapp-unofficial` claimed a member box ships the
  // unofficial WhatsApp bridge. It does not. WhatsApp appears in neither
  // engine/connect/mcp-registry.json nor the connections catalogue; the bridge
  // runs on the operator's own second brain. The claim was written against an
  // assumption about the product rather than the product, and would have sat
  // pending forever against a page there is no reason to write.
];

// --- the billing caveat -----------------------------------------------------
// Shots that photograph a price. Pricing is DISPLAY-ONLY until the 26 Sep
// read-date, so any page showing one of these must say so on the page: a
// screenshot of a number reads as a commitment.
// door-catalogue photographs Hetzner's list prices (2026-09-09).
export const BILLING_SHOTS = ['member-overview', 'door-catalogue'];
export const BILLING_CAVEAT = 'indicative';

// --- the checks, as functions ----------------------------------------------
// Kept here rather than inline in the test so each can be pinned on synthetic
// pages before the real page exists, the same way the legal lock is.

const text = (pg) => `${pg.title || ''} ${pg.summary || ''} ${pg.body || ''}`;

// Claims are matched against NORMALISED prose: lowercased, emphasis markers
// stripped, all whitespace collapsed to single spaces. Without this a pinned
// claim breaks when a paragraph is re-wrapped or half the sentence is bolded,
// which is a formatting change and not a lost promise. Found immediately, by
// the privacy policy: the drafted line wrapped between "Crads AI" and "reads
// your notes" and the gate called the commitment missing.
const norm = (s) => String(s).toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

// Phrase matching, so ordinary English keeps working. See BANNED_PHRASES for
// why this is not a token scan.
export function checkVocab(pages) {
  const hits = [];
  for (const pg of pages) {
    const t = text(pg);
    for (const { id, re } of BANNED_PHRASES) {
      const m = re.exec(t);
      if (m) hits.push(`${pg.slug}: ${id} ("${m[0].trim()}")`);
    }
  }
  return hits;
}

export function checkClaims(pages) {
  const by = new Map(pages.map((p) => [p.slug, p]));
  const broken = [];
  const pending = [];
  for (const c of PINNED_CLAIMS) {
    const pg = by.get(c.slug);
    if (!pg) { pending.push(`${c.id} -> ${c.slug}.md`); continue; }
    if (!norm(text(pg)).includes(norm(c.must))) {
      broken.push(`${c.slug}: lost "${c.must}" (${c.why})`);
    }
  }
  return { broken, pending };
}

export function checkBilling(pages, shotRefsOf) {
  const bad = [];
  for (const pg of pages) {
    const shown = shotRefsOf(pg.body).filter((s) => BILLING_SHOTS.includes(s));
    if (!shown.length) continue;
    if (!norm(text(pg)).includes(norm(BILLING_CAVEAT))) {
      bad.push(`${pg.slug}: shows ${shown.join(', ')} without saying "${BILLING_CAVEAT}"`);
    }
  }
  return bad;
}
