// case.mjs - the sentence-case rule for docs copy.
//
// Sam's standing rule for product copy (memory feedback_sentence_case_product_copy):
// buttons, headings, cards and nav are sentence case; uppercase only via CSS.
// It applies to documentation for the same reason it applies to the app, and
// the docs are the surface most likely to drift into Title Case out of habit.
//
// Two directions, both real:
//   - Title Case: a mid-sentence word capitalised for no reason.
//   - lowercase headings: a raw slug used as a heading. The generated skills
//     page shipped four ('box', 'briefing', ...) until this gate existed.
//
// Getting the first direction right needs sentence awareness. A naive
// "every word after the first" check reported 26 violations on the legal pages
// and every one was a false positive: numbered headings ("7. Ending it") and
// sentence continuations ("Layer 1: the machinery. We maintain it.").

// Words that legitimately carry a capital mid-sentence: proper nouns, product
// names, and UI labels quoted as they appear on screen.
export const PROPER = new Set(`Crads AI ChatGPT Google Microsoft Claude Code Gmail Calendar Drive Docs Sheets
Tasks Contacts Telegram GitHub Hetzner DigitalOcean Cloudflare Anthropic Notion Linear Sentry Canva Vercel Apify
PayPal Square Figma Asana Atlassian Intercom Australian Australia NSW Coogee Samuel Davis Sam Mel
Harper Driftwood Surf School Advanced External Publish Production Testing Desktop Web OAIC ABN GST
Members Skills Connections Overview Terminal Help Sharing Privacy Network Your Rock Rocks Pebbles
Billing Cron Update Refresh Monday Tuesday Wednesday Thursday Friday Saturday Sunday January
September August AEST Diataxis Linux JSON SSH MCP API APIs Nuremberg Falkenstein Helsinki Germany
Finland Wales South New Briefings Capture Everything I A The`.split(/\s+/).filter(Boolean));

const midSentenceWords = (text) => String(text)
  .replace(/^\s*\d+[.)]\s*/, '')                      // drop a leading enumerator
  .split(/(?<=[.:!?])\s+/)                            // one entry per sentence
  .flatMap((sent) => sent.trim().split(/\s+/).slice(1));  // skip each sentence's first word

export function caseProblems(pages) {
  const out = [];
  const check = (slug, kind, text) => {
    if (!text) return;
    const bad = midSentenceWords(text).filter((w) => {
      const bare = w.replace(/[^A-Za-z-]/g, '');
      if (!bare || !/^[A-Z]/.test(bare)) return false;
      if (PROPER.has(bare)) return false;
      if (/^[A-Z]{2,}$/.test(bare)) return false;     // acronyms
      if (bare.includes('-') && bare.split('-').every((part) => PROPER.has(part))) return false;
      return true;
    });
    if (bad.length) out.push(`${slug} [${kind}] "${text}" -> Title Case: ${[...new Set(bad)].join(', ')}`);
  };
  for (const pg of pages) {
    check(pg.slug, 'title', pg.title);
    check(pg.slug, 'summary', pg.summary);
    for (const line of String(pg.body).split('\n')) {
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (!h) continue;
      check(pg.slug, 'heading', h[1]);
      if (/^[a-z]/.test(h[1])) out.push(`${pg.slug} [heading] "${h[1]}" -> starts lowercase`);
    }
  }
  return out;
}
