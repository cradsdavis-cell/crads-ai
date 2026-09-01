// render.mjs - the renderer skeleton, per the documentation-system spec
// (docs/superpowers/specs/2026-08-24-documentation-system.md, build step 1).
//
// Two outputs, both consumed by later build steps:
//   renderPage(page)      -> an HTML fragment (no shell: the website and the
//                            in-image surface each wrap fragments themselves)
//   buildManifest(pages)  -> the site tree as data: per-tier, mode-grouped,
//                            order-sorted. The website nav, the in-image
//                            index, and the PDF exports all read this one
//                            structure so they can never disagree.
//
// The markdown dialect is a deliberate subset (headings, paragraphs, bold,
// italic, inline code, links, lists, fenced code, blockquotes, tables). Zero
// deps like the rest of the repo. A page needing more than this subset is a
// page fighting the medium.
import { visibleTo, MODES } from './source.mjs';
import { shotSrc, marksFor } from './shots.mjs';
import { renderDiagram } from './diagrams.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Inline spans. Escape FIRST, then substitute: markup never originates from
// page text (member fragments taught this the hard way; same discipline here).
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) =>
      /^(https?:\/\/|\/|#)/.test(href) ? `<a href="${href}">${t}</a>` : t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// A shot is ALWAYS its own block: ![alt](shot:some-id) alone on a line. A
// <figure> cannot live inside a <p>, and a docs screenshot that wants to sit
// mid-sentence is a screenshot that wants to be a smaller screenshot. The gate
// (shots.test.mjs) refuses the inline form rather than rendering it wrong.
export const SHOT_LINE = /^\s*!\[([^\]]*)\]\(shot:([a-z0-9-]+)\)\s*$/;
export const SHOT_ANY = /!\[[^\]]*\]\(shot:[a-z0-9-]+\)/;
// A diagram is inlined by id, same block-only rule as a shot.
export const DIAGRAM_LINE = /^\s*!\[([^\]]*)\]\(diagram:([a-z0-9-]+)\)\s*$/;
export const DIAGRAM_ANY = /!\[[^\]]*\]\(diagram:[a-z0-9-]+\)/;

function renderShot(alt, id, shotsDir) {
  const a = esc(alt);
  const marks = marksFor(id, shotsDir);

  // ANNOTATIONS ARE TEXT, NOT PIXELS. Numbered markers are positioned over the
  // image in percentages, and the legend beneath is ordinary prose. So a callout
  // is selectable, searchable, readable by a screen reader and translatable, the
  // PNG stays clean and re-shootable, and nothing has to be re-drawn when the
  // screenshot is retaken. Burning numbers into the image would lose all of that
  // and rot the moment the UI moved.
  const overlay = marks.length ? marks.map((m) =>
    `<span class="shot-mark" style="left:${m.x}%;top:${m.y}%;width:${m.w}%;height:${m.h}%">`
    + `<b aria-hidden="true">${m.n}</b></span>`).join('') : '';
  const legend = marks.length
    ? `<ol class="shot-legend">${marks.map((m) => `<li>${esc(m.say)}</li>`).join('')}</ol>`
    : '';

  // The image links to itself so a reader can open it at full size. A screenshot
  // displayed inside a reading column is always smaller than the screen it was
  // taken from, and "squint at it" is not a reading experience.
  return `<figure class="shot${marks.length ? ' marked' : ''}">`
    + `<span class="shot-frame"><a href="${shotSrc(id)}" target="_blank" rel="noopener">`
    + `<img src="${shotSrc(id)}" alt="${a}" loading="lazy"></a>${overlay}</span>`
    + (a ? `<figcaption>${a}</figcaption>` : '') + legend + '</figure>';
}

// A heading's id: lowercase, words joined by hyphens, deduped within the page.
// Markup and punctuation are dropped so the id survives an emphasis change.
export function headingId(text, seen) {
  const base = String(text).toLowerCase().replace(/`|\*|_/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  if (!seen) return base;
  let id = base; let n = 2;
  while (seen.has(id)) { id = `${base}-${n}`; n += 1; }
  seen.add(id);
  return id;
}

// The h2/h3 headings of a page body, in order, for the on-page contents.
export function outline(body) {
  const seen = new Set();
  const out = [];
  let fence = false;
  for (const line of String(body).split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/`|\*\*|\*/g, '').trim(), id: headingId(m[2], seen) });
  }
  return out;
}

// `opts.shotsDir` overrides where a shot's annotation sidecar is read from.
// Production never passes it (the default is the rig's own output directory);
// tests do, because that directory is a gitignored build artefact and a test
// that reads it is red on every clean checkout (trap 62).
export function renderMarkdown(md, opts = {}) {
  const out = [];
  const seen = new Set();
  const lines = md.split('\n');
  let i = 0;
  const listStack = []; // 'ul' | 'ol'
  const closeLists = (depth = 0) => { while (listStack.length > depth) out.push(`</${listStack.pop()}>`); };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // fenced code, verbatim until the closing fence
      closeLists();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // A shot directive alone on its line is a BLOCK: a <figure> inside a <p>
    // is invalid HTML, and a docs screenshot is always its own block anyway.
    // Inline shots (mid-sentence) still work through inline() below.
    const shot = SHOT_LINE.exec(line);
    if (shot) { closeLists(); out.push(renderShot(shot[1], shot[2], opts.shotsDir)); i++; continue; }
    const dgm = DIAGRAM_LINE.exec(line);
    if (dgm) {
      closeLists();
      const svg = renderDiagram(dgm[2]);
      // A diagram id that does not exist is a build failure, not a blank space:
      // the same rule the shot gate follows, for the same reason.
      if (!svg) throw new Error(`unknown diagram: ${dgm[2]}`);
      out.push(svg); i++; continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      // h2 and h3 get a stable id and a quiet anchor, so a reader can link to a
      // section and the on-page contents has something to point at. Derived from
      // the heading text, deduped, and never invented by hand.
      if (lvl === 2 || lvl === 3) {
        const id = headingId(h[2], seen);
        out.push(`<h${lvl} id="${id}">${inline(h[2])}`
          + `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${lvl}>`);
      } else {
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      }
      i++; continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor(li[1].length / 2) + 1;
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth) { listStack.push(kind); out.push(`<${kind}>`); }
      // A wrapped item continues on indented lines below it. Until 2026-08-25
      // those lines fell through to the paragraph branch, which force-closes
      // open lists, so EVERY wrapped item on EVERY published page rendered as
      // a one-item list plus a stray indented paragraph, and numbered steps
      // read 1, 1, 1, 1. Found by reading the built HTML of a four-step list.
      const item = [li[3]];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])
        && !/^(\s*)([-*]|\d+\.)\s/.test(lines[i])
        && !/^\s*(#{1,4}\s|```|>|\|)/.test(lines[i])
        && !SHOT_LINE.test(lines[i]) && !DIAGRAM_LINE.test(lines[i])) item.push(lines[i++].trim());
      out.push(`<li>${inline(item.join(' '))}</li>`); continue;
    }
    closeLists();
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`); continue;
    }
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|```|[-*]\s|\d+\.\s|>|\|)/.test(lines[i])
      && !SHOT_LINE.test(lines[i]) && !DIAGRAM_LINE.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeLists();
  return out.join('\n');
}

// A page fragment: header carries the contract fields the surfaces need
// (mode chip, install id for the how-to button, legal version line).
export function renderPage(page, opts = {}) {
  const bits = [`<article data-mode="${page.mode}" data-audience="${page.audience}" id="${esc(page.slug)}">`,
    `<h1>${esc(page.title)}</h1>`];
  if (page.mode === 'legal') bits.push(`<p class="legal-stamp">Version ${esc(page.version)}, effective ${esc(page.effective)}. Samuel Davis trading as Crads AI.</p>`);
  bits.push(renderMarkdown(page.body, opts));
  if (page.mode === 'how-to' && page.installs) {
    // The install affordance is DATA here; the in-image surface wires it to
    // catalog-install, the website renders it as the ad for the pebble tier.
    bits.push(`<div class="install" data-installs="${esc(page.installs)}"></div>`);
  }
  bits.push('</article>');
  return bits.join('\n');
}

export function buildManifest(pages) {
  const tiers = {};
  for (const tier of ['public', 'pebble', 'rock']) {
    const seen = visibleTo(pages, tier);
    tiers[tier] = {};
    for (const mode of MODES) {
      const group = seen.filter((p) => p.mode === mode)
        .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
        .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary, audience: p.audience, installs: p.installs, generated: p.generated }));
      if (group.length) tiers[tier][mode] = group;
    }
  }
  return { tiers, count: pages.length };
}
