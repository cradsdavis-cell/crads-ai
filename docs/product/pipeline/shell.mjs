// shell.mjs - the crads-ai.com page shell, so a rendered doc is a site page and
// not a stylesheet-less orphan.
//
// The nav, footer and asset paths below are COPIED from the live site's
// about/index.html (samdavis-site, Vercel project crads-ai, 2026-08-24). That is
// a deliberate duplication with a cost: if the site's nav changes, this goes
// stale and every docs page wears last month's nav.
//
// The alternative was templating the site's own HTML, which would couple the
// docs build to that repo's markup and break the moment either side moved. This
// way the drift is visible (one file, one place) and a page still renders
// correctly with a stale nav, which is the failure mode worth having.
// `publish.test.mjs` pins the nav links against the live site's own file when it
// is present on disk, so the drift is caught rather than discovered.

export const SITE = 'https://crads-ai.com';

// The site name every published page reports in og:site_name. Until
// 2026-09-09 this was the site's pre-existing brand string, em dash and all,
// carried here as the one permitted em dash per page (publish.test.mjs counts
// the brand's em dashes and allows exactly that many). The v4 one-stop-shop
// site renamed itself to the product, site-wide, in the same wave; the docs
// pages follow, and the count the test allows is now zero.
export const SITE_NAME = 'Crads-AI';

const NAV = `
<nav class="site-nav-bar" aria-label="Primary">
  <a href="/" class="brand" aria-label="crads-ai home">
    <img src="/lib/img/sam-illustration-sm.png" alt="">
    <span class="wordmark">crads-<span class="accent">ai</span></span>
  </a>
  <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav-links" aria-label="Open menu">
    <span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span>
  </button>
  <div class="nav-links" id="site-nav-links">
    <a href="/docs" class="nav-simple current">Docs</a>
    <a href="/how-it-works" class="nav-simple">How it works</a>
    <a href="/offer" class="nav-simple">Setup and support</a>
    <a href="/about" class="nav-simple">About</a>
    <a href="/book" class="nav-simple nav-book">Book a call</a>
    <a href="/download" class="nav-simple nav-cta">Download</a>
  </div>
</nav>`;

const FOOTER = `
<footer class="site-footer wrap">
  <span class="wordmark">crads-<span class="accent">ai</span></span>
  <div><a href="mailto:cradsdavis@gmail.com">cradsdavis@gmail.com</a></div>
  <div><a href="https://linkedin.com/in/samuel-davis4" target="_blank" rel="noopener">linkedin.com/in/samuel-davis4</a></div>
  <div><a href="/book">Book a 30-minute call →</a></div>
  <div class="location">Coogee, Sydney.</div>
</footer>`;

// Docs-only styles. Every value is one of the site's own tokens (lib/site.css
// :root) rather than a new palette: docs that look adjacent to the site are
// worse than docs that look like it. Scoped under .docs-* so nothing here can
// reach the rest of the site, which is the lesson from porting markup between
// surfaces: bare element selectors leak.
const STYLE = `
<style>
  /* ================= docs chrome, enterprise pass (2026-08-25) ============
     Sam: "mirror state of the art enterprise level software documentation."
     The reference class is Stripe / Linear / Vercel: sans type throughout,
     a dense collapsible sidebar with an active rail, breadcrumbs, a
     scroll-spied on-page rail, admonition callouts, chip-styled inline code,
     card landings and command-K search. Everything below is hand-rolled and
     inline because this pipeline ships zero dependencies, and every colour
     is one of the site's own tokens so the docs stay the site's docs. */

  .docs-page { max-width: none; }
  .docs-shell { display: grid; grid-template-columns: 240px minmax(0,1fr) 200px;
    gap: var(--space-4); align-items: start; max-width: var(--wrap-max); }
  @media (max-width: 1080px) { .docs-shell { grid-template-columns: 224px minmax(0,1fr); } .docs-toc { display: none; } }
  @media (max-width: 820px)  { .docs-shell { grid-template-columns: minmax(0,1fr); gap: var(--space-3); } }

  /* ---- sidebar ---------------------------------------------------------- */
  .docs-side { position: sticky; top: var(--space-3); font-family: var(--sans);
    font-size: 13.5px; max-height: calc(100vh - var(--space-4)); overflow-y: auto;
    scrollbar-width: thin; padding-right: 6px; }
  /* DESKTOP ONLY: the OUTER wrapper has no disclosure and shows its tree
     whether or not it is open; the INNER group details stay real toggles.
     Scoped to a min-width because unscoped it also forced the tree open on
     mobile, which is the exact thing the closed default exists to avoid.
     Verified in a browser at both widths rather than reasoned about. */
  @media (min-width: 821px) {
    .docs-side > details > summary { display: none; }
    .docs-side > details > *:not(summary) { display: revert; }
    .docs-side > details::details-content { content-visibility: visible; display: revert; block-size: auto; }
  }
  .docs-search-btn { display: flex; align-items: center; gap: 8px; width: 100%;
    font-family: var(--sans); font-size: 13px; color: var(--ink-faint);
    background: var(--bg-main); border: 1px solid var(--rule); border-radius: 8px;
    padding: 7px 10px; cursor: pointer; margin: 0 0 var(--space-2); text-align: left; }
  .docs-search-btn:hover { border-color: var(--ink-faint); color: var(--ink-soft); }
  .docs-search-btn .k { margin-left: auto; }
  .docs-kbd { font-family: var(--sans); font-size: 10.5px; font-weight: 600;
    color: var(--ink-faint); border: 1px solid var(--rule); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 5px; background: var(--bg-soft); }
  .docs-side .navhome { display: block; font-size: 13px; font-weight: 600;
    color: var(--ink-soft); text-decoration: none; padding: 4px 0 10px; }
  .docs-side .navhome:hover { color: var(--accent-deep); }
  .docs-side details.navgrp { margin: 0 0 2px; }
  .docs-side details.navgrp > summary { display: flex; align-items: center;
    cursor: pointer; list-style: none; font-size: 12.5px; font-weight: 650;
    color: var(--ink-deep); padding: 7px 4px 5px; border-radius: 6px; user-select: none; }
  .docs-side details.navgrp > summary::-webkit-details-marker { display: none; }
  .docs-side details.navgrp > summary::after { content: ""; width: 7px; height: 7px;
    margin-left: auto; border-right: 1.6px solid var(--ink-faint);
    border-bottom: 1.6px solid var(--ink-faint); transform: rotate(-45deg);
    transition: transform .12s; }
  .docs-side details.navgrp[open] > summary::after { transform: rotate(45deg); }
  .docs-side details.navgrp > summary:hover { background: var(--bg-soft); }
  .docs-side ul { list-style: none; margin: 0 0 6px; padding: 0 0 0 2px; }
  .docs-side ul a { display: block; padding: 4.5px 10px; border-left: 2px solid var(--rule);
    border-radius: 0 6px 6px 0; color: var(--ink-soft); text-decoration: none;
    line-height: 1.35; }
  .docs-side ul a:hover { background: var(--bg-soft); color: var(--ink-deep); }
  .docs-side ul a[aria-current="page"] { border-left-color: var(--accent-deep);
    background: var(--accent-glow); color: var(--accent-deep); font-weight: 600; }
  @media (max-width: 820px) {
    .docs-side { position: static; max-height: none; border-bottom: 1px solid var(--rule);
      padding-bottom: var(--space-2); margin-bottom: var(--space-2); }
    .docs-side > details > summary { display: block; cursor: pointer; font-family: var(--sans);
      font-weight: 600; color: var(--ink-deep); list-style: none; padding: 6px 0; }
    .docs-side details > summary::-webkit-details-marker { display: none; }
    .docs-side > details > summary::before { content: "\\2630"; margin-right: 8px; color: var(--ink-faint); }
  }

  /* ---- breadcrumbs ------------------------------------------------------- */
  .docs-crumbs { font-family: var(--sans); font-size: 12.5px; color: var(--ink-faint);
    margin: 0 0 var(--space-2); display: flex; gap: 7px; align-items: center; }
  .docs-crumbs a { color: var(--ink-faint); text-decoration: none; }
  .docs-crumbs a:hover { color: var(--accent-deep); }
  .docs-crumbs .sep { color: var(--rule); }
  .docs-crumbs .here { color: var(--ink-soft); font-weight: 550; }

  /* ---- article type ------------------------------------------------------ */
  /* Sans throughout: the site's Palatino display headings are right for the
     landing pages and read as a blog here. Enterprise documentation is one
     family, tight tracking, quiet weights. */
  .docs-article { max-width: 660px; }
  .docs-index .docs-article { max-width: none; }
  .docs-article h1, .docs-article h2, .docs-article h3, .docs-article h4 {
    font-family: var(--sans); color: var(--ink-deep); letter-spacing: -0.015em; }
  .docs-article h1 { font-size: 27px; line-height: 1.2; font-weight: 700; margin: 0 0 var(--space-1); }
  .docs-article h2 { font-size: 19px; line-height: 1.3; font-weight: 650; margin: 34px 0 10px; }
  .docs-article h3 { font-size: 16px; line-height: 1.35; font-weight: 650; margin: 24px 0 6px; }
  .docs-article p, .docs-article li { font-family: var(--sans); font-size: 15px; line-height: 1.65; color: var(--ink-soft); }
  .docs-article strong, .docs-article b { color: var(--ink-deep); font-weight: 620; }
  .docs-article ul, .docs-article ol { padding-left: 24px; margin: 10px 0; }
  .docs-article li { margin: 4px 0; }
  .docs-article li > ul, .docs-article li > ol { margin: 4px 0; }
  .docs-article a { color: var(--accent-deep); text-decoration: none;
    border-bottom: 1px solid transparent; }
  .docs-article a:hover { border-bottom-color: var(--accent-deep); }
  .docs-article .docs-summary { font-family: var(--sans); font-size: 15.5px; color: var(--ink-faint);
    margin: 0 0 var(--space-3); line-height: 1.55; }
  .docs-article em { color: inherit; }
  .docs-article h2, .docs-article h3 { scroll-margin-top: var(--space-3); }
  .docs-article h2 .anchor, .docs-article h3 .anchor { opacity: 0; text-decoration: none;
    border: 0; margin-left: 8px; color: var(--ink-faint); font-weight: 400; }
  .docs-article h2:hover .anchor, .docs-article h3:hover .anchor { opacity: 1; }
  .docs-article code { font-family: var(--mono); font-size: 13px; background: var(--bg-soft);
    border: 1px solid var(--rule); border-radius: 5px; padding: 1px 5px; color: var(--ink-deep); }
  .docs-article pre code { background: none; border: 0; padding: 0; font-size: 13px; }

  /* ---- tables ------------------------------------------------------------ */
  .docs-article table { width: 100%; border-collapse: collapse; margin: var(--space-2) 0 var(--space-3);
    font-family: var(--sans); font-size: 13.5px; display: block; overflow-x: auto; }
  .docs-article th { text-align: left; font-size: 12px; font-weight: 650;
    letter-spacing: .04em; text-transform: uppercase; color: var(--ink-faint);
    padding: 8px 16px 8px 0; border-bottom: 1.5px solid var(--rule); }
  .docs-article td { text-align: left; padding: 9px 16px 9px 0;
    border-bottom: 1px solid var(--rule); vertical-align: top; color: var(--ink-soft); }
  .docs-article tbody tr:hover td { background: var(--bg-soft); }

  /* ---- code blocks ------------------------------------------------------- */
  .docs-article .codewrap { position: relative; margin: var(--space-2) 0 var(--space-3); }
  .docs-article pre { background: var(--bg-soft); border: 1px solid var(--rule);
    padding: 14px 16px; border-radius: 9px; overflow-x: auto; font-size: 13px;
    line-height: 1.6; margin: 0; }
  .docs-article .copy { position: absolute; top: 8px; right: 8px; font-family: var(--sans);
    font-size: 11.5px; font-weight: 600; padding: 4px 10px; border: 1px solid var(--rule);
    border-radius: 6px; background: var(--bg-main); color: var(--ink-faint);
    cursor: pointer; opacity: 0; transition: opacity .12s; }
  .docs-article .codewrap:hover .copy, .docs-article .copy:focus { opacity: 1; }

  /* ---- callouts ---------------------------------------------------------- */
  .docs-article blockquote { margin: var(--space-2) 0 var(--space-3); padding: 12px 16px 12px 14px;
    border: 1px solid var(--rule); border-left: 3px solid var(--accent);
    background: var(--bg-soft); border-radius: 8px; }
  .docs-article blockquote::before { content: "Note"; display: block; font-family: var(--sans);
    font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
    color: var(--accent-deep); margin-bottom: 4px; }
  .docs-article blockquote p { margin: 0; font-size: 14.5px; }

  /* ---- screenshots + annotations ----------------------------------------- */
  .docs-article figure.shot { margin: var(--space-3) 0; }
  .docs-article .shot-frame { position: relative; display: block; line-height: 0;
    border: 1px solid var(--rule); border-radius: 10px; overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,.05); }
  .docs-article figure.shot img { width: 100%; height: auto; display: block; }
  .docs-article figure.shot figcaption { font-family: var(--sans); font-size: 12.5px;
    color: var(--ink-faint); margin-top: 8px; }
  .docs-article .shot-mark { position: absolute; box-sizing: border-box;
    border: 2px solid var(--accent); border-radius: 6px;
    box-shadow: 0 0 0 3px rgba(255,255,255,.55); pointer-events: none; }
  .docs-article .shot-mark b { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px;
    border-radius: 50%; background: var(--accent); color: #fff; font-family: var(--sans);
    font-size: 12.5px; font-weight: 700; line-height: 22px; text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,.28); }
  .docs-article .shot-legend { list-style: none; counter-reset: mark; margin: 12px 0 0; padding: 0;
    font-family: var(--sans); font-size: 13.5px; color: var(--ink-soft); }
  .docs-article .shot-legend li { counter-increment: mark; position: relative; padding: 4px 0 4px 30px; line-height: 1.55; }
  .docs-article .shot-legend li::before { content: counter(mark); position: absolute; left: 0; top: 4px;
    width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: #fff;
    font-size: 11.5px; font-weight: 700; line-height: 20px; text-align: center; }
  @media (max-width: 640px) { .docs-article .shot-mark b { width: 18px; height: 18px; line-height: 18px; font-size: 11px; left: -9px; top: -9px; } }

  /* ---- diagrams ----------------------------------------------------------- */
  .docs-article figure.diagram { margin: var(--space-3) 0; }
  .docs-article figure.diagram svg.dgm { width: 100%; height: auto; display: block; }
  .docs-article figure.diagram figcaption { font-family: var(--sans); font-size: 12.5px;
    color: var(--ink-faint); margin-top: 10px; }
  .docs-article figure.diagram text { font-family: var(--sans); }

  /* ---- on-page rail, scroll-spied ------------------------------------------ */
  .docs-toc { position: sticky; top: var(--space-3); font-family: var(--sans); font-size: 12.5px; }
  .docs-toc h2 { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--ink-faint); margin: 0 0 8px; font-weight: 650; font-family: var(--sans); }
  .docs-toc ul { list-style: none; margin: 0; padding: 0; }
  .docs-toc a { display: block; padding: 4px 0 4px 12px; border-left: 2px solid var(--rule);
    color: var(--ink-faint); text-decoration: none; line-height: 1.45; }
  .docs-toc a:hover { color: var(--ink-deep); }
  .docs-toc a.on { color: var(--accent-deep); border-left-color: var(--accent-deep); font-weight: 600; }

  /* ---- prev / next ---------------------------------------------------------- */
  .docs-nextprev { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2);
    margin-top: var(--space-5); padding-top: var(--space-3); border-top: 1px solid var(--rule);
    font-family: var(--sans); }
  .docs-nextprev a { display: block; padding: 12px 16px; border: 1px solid var(--rule);
    border-radius: 10px; text-decoration: none; color: var(--ink-deep); font-size: 14.5px;
    font-weight: 600; transition: border-color .12s; }
  .docs-nextprev a:hover { border-color: var(--accent-deep); }
  .docs-nextprev .dir { display: block; font-size: 10.5px; letter-spacing: .06em; font-weight: 650;
    text-transform: uppercase; color: var(--ink-faint); margin-bottom: 3px; }
  .docs-nextprev .next { text-align: right; }
  @media (max-width: 560px) { .docs-nextprev { grid-template-columns: 1fr; } }

  /* ---- persona badge ------------------------------------------------------- */
  .docs-badge { display: inline-block; font-family: var(--sans); font-size: 10px;
    font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
    color: var(--accent-deep); background: var(--accent-glow);
    border: 1px solid var(--accent); border-radius: 99px; padding: 1px 7px;
    margin-left: 7px; vertical-align: 1px; font-style: normal; }
  .docs-badge.lg { font-size: 10.5px; padding: 2px 9px; margin-left: 10px; }

  /* ---- landing: doors + card grids ------------------------------------------ */
  .docs-doors { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-4); font-family: var(--sans); }
  .docs-doors .door { border: 1px solid var(--rule); border-radius: 12px;
    padding: 18px 20px; background: var(--bg-soft); }
  .docs-doors h2 { font-family: var(--sans); font-size: 16.5px; letter-spacing: -0.01em; margin: 0 0 4px; }
  .docs-doors .lead { font-size: 13.5px; color: var(--ink-faint); margin: 0 0 12px; line-height: 1.5; }
  .docs-doors ol { list-style: none; margin: 0; padding: 0; }
  .docs-doors li { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
  .docs-doors .n { flex: none; width: 20px; height: 20px; border-radius: 50%;
    background: var(--accent); color: #fff; font-size: 11.5px; font-weight: 700;
    line-height: 20px; text-align: center; }
  .docs-doors a { font-weight: 600; text-decoration: none; font-size: 14px; }
  @media (max-width: 900px) { .docs-doors { grid-template-columns: 1fr; } }
  .docs-index-groups { display: grid; gap: var(--space-4); font-family: var(--sans); }
  .docs-index-groups h2 { font-family: var(--sans); font-size: 18px; letter-spacing: -0.01em;
    margin: 0 0 2px; }
  .docs-index-groups .docs-summary { margin-bottom: var(--space-2); font-size: 14px; }
  .docs-index-groups .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 700px) { .docs-index-groups .cards { grid-template-columns: 1fr; } }
  .docs-index-groups .card { display: block; border: 1px solid var(--rule); border-radius: 10px;
    padding: 12px 14px; text-decoration: none; transition: border-color .12s; }
  .docs-index-groups .card:hover { border-color: var(--accent-deep); }
  .docs-index-groups .card b { display: block; font-size: 14px; font-weight: 650;
    color: var(--ink-deep); letter-spacing: -0.005em; margin-bottom: 2px; }
  .docs-index-groups .card span { display: block; font-size: 13px; color: var(--ink-faint);
    line-height: 1.5; }

  /* ---- search ---------------------------------------------------------------- */
  .docs-search-veil { position: fixed; inset: 0; background: rgba(30,26,20,.35);
    display: none; z-index: 90; }
  .docs-search-veil.open { display: block; }
  .docs-search-box { position: fixed; z-index: 91; left: 50%; top: 14vh;
    transform: translateX(-50%); width: min(560px, calc(100vw - 32px));
    background: var(--bg-main); border: 1px solid var(--rule); border-radius: 12px;
    box-shadow: 0 18px 50px rgba(0,0,0,.22); display: none; overflow: hidden;
    font-family: var(--sans); }
  .docs-search-box.open { display: block; }
  .docs-search-box input { width: 100%; border: 0; outline: none; background: transparent;
    font: 15px/1.4 var(--sans); color: var(--ink-deep); padding: 14px 16px;
    border-bottom: 1px solid var(--rule); }
  .docs-search-box .res { max-height: 46vh; overflow-y: auto; padding: 6px; }
  .docs-search-box .r { display: block; padding: 9px 10px; border-radius: 8px;
    text-decoration: none; cursor: pointer; }
  .docs-search-box .r b { display: block; font-size: 14px; font-weight: 600; color: var(--ink-deep); }
  .docs-search-box .r span { display: block; font-size: 12.5px; color: var(--ink-faint);
    line-height: 1.45; margin-top: 1px; }
  .docs-search-box .r .g { display: inline-block; font-size: 10.5px; font-weight: 650;
    letter-spacing: .04em; text-transform: uppercase; color: var(--accent-deep);
    margin-bottom: 2px; }
  .docs-search-box .r.on, .docs-search-box .r:hover { background: var(--bg-soft); }
  .docs-search-box .none { padding: 16px; font-size: 13.5px; color: var(--ink-faint); }
</style>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    // Copy button per code block. Inline rather than bundled: the docs are
    // static files and one listener beats a build step.
    document.querySelectorAll('.docs-article pre').forEach(function (pre) {
      var wrap = document.createElement('div');
      wrap.className = 'codewrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'copy'; b.textContent = 'Copy';
      b.addEventListener('click', function () {
        navigator.clipboard.writeText(pre.innerText).then(function () {
          b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1400);
        }).catch(function () { b.textContent = 'Press Ctrl+C'; });
      });
      wrap.appendChild(b);
    });

    // Scroll-spy for the on-page rail: the heading nearest the top of the
    // viewport lights its rail entry. IntersectionObserver, no scroll math.
    var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.docs-toc a'));
    if (tocLinks.length) {
      var byId = {};
      tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
      var current = null;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          if (current) current.classList.remove('on');
          current = byId[e.target.id];
          if (current) current.classList.add('on');
        });
      }, { rootMargin: '0px 0px -70% 0px' });
      Object.keys(byId).forEach(function (id) {
        var h = document.getElementById(id);
        if (h) io.observe(h);
      });
    }

    // Search: the index ships with the page (window.__DOCS_INDEX__, built at
    // publish time), so this is a filter over data already here, not a request.
    var IDX = window.__DOCS_INDEX__ || [];
    if (!IDX.length) return;
    var veil = document.createElement('div'); veil.className = 'docs-search-veil';
    var box = document.createElement('div'); box.className = 'docs-search-box';
    box.innerHTML = '<input type="search" placeholder="Search the docs..." aria-label="Search the docs">'
      + '<div class="res"></div>';
    document.body.appendChild(veil); document.body.appendChild(box);
    var input = box.querySelector('input'), res = box.querySelector('.res');
    var sel = 0, hits = [];
    function close() { veil.classList.remove('open'); box.classList.remove('open'); }
    function open() { veil.classList.add('open'); box.classList.add('open'); input.value = ''; render(''); input.focus(); }
    function render(q) {
      q = q.trim().toLowerCase();
      hits = [];
      if (q) {
        IDX.forEach(function (p) {
          var t = p.t.toLowerCase(), s = (p.s || '').toLowerCase();
          var inHead = (p.h || []).some(function (h) { return h.toLowerCase().indexOf(q) >= 0; });
          var rank = t.indexOf(q) >= 0 ? 0 : inHead ? 1 : s.indexOf(q) >= 0 ? 2 : -1;
          if (rank >= 0) hits.push({ p: p, rank: rank });
        });
        hits.sort(function (a, b) { return a.rank - b.rank; });
        hits = hits.slice(0, 10);
      } else {
        hits = IDX.slice(0, 8).map(function (p) { return { p: p, rank: 0 }; });
      }
      sel = 0;
      res.innerHTML = hits.length
        ? hits.map(function (h, i) {
            return '<a class="r' + (i === 0 ? ' on' : '') + '" href="/docs/' + h.p.u + '">'
              + '<span class="g">' + h.p.g + '</span>'
              + '<b>' + h.p.t + '</b><span>' + h.p.s + '</span></a>';
          }).join('')
        : '<div class="none">Nothing matches. The sidebar lists every page.</div>';
    }
    function move(d) {
      var rows = res.querySelectorAll('.r');
      if (!rows.length) return;
      rows[sel] && rows[sel].classList.remove('on');
      sel = (sel + d + rows.length) % rows.length;
      rows[sel].classList.add('on');
      rows[sel].scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { var r = res.querySelectorAll('.r')[sel]; if (r) location.href = r.getAttribute('href'); }
      else if (e.key === 'Escape') close();
    });
    veil.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
      else if (e.key === '/' && !typing && !box.classList.contains('open')) { e.preventDefault(); open(); }
    });
    var btn = document.querySelector('.docs-search-btn');
    if (btn) btn.addEventListener('click', open);
  });
</script>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function shell({ title, description, path, body, extraClass = '', side = '', toc = '', nextprev = '', search = '' }) {
  // Middle dot, not an em dash. The zero-em-dash rule applies to everything we
  // write, and this template was written in violation of it: publish.test.mjs
  // caught the title of every single page. The site's own older titles use an em
  // dash; new output does not.
  const full = `${title} · Crads AI docs`;
  const url = `${SITE}${path}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="icon" type="image/png" sizes="64x64" href="/lib/img/favicon.png">
<link rel="icon" type="image/x-icon" href="/lib/img/favicon.ico">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="/lib/site.css">
<script defer src="/lib/site.js"></script>
${STYLE}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/lib/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/lib/img/og-card.png">
</head>
<body>
${NAV}
<main class="docs-page wrap ${extraClass}">
<div class="docs-shell">
${side ? `<aside class="docs-side">${side}</aside>` : '<div></div>'}
<article class="docs-article">
${body}
${nextprev}
</article>
${toc ? `<nav class="docs-toc" aria-label="On this page">${toc}</nav>` : ''}
</div>
</main>
${search ? `<script>window.__DOCS_INDEX__ = ${search};</script>` : ''}
${FOOTER}
</body>
</html>
`;
}

export const NAV_HTML = NAV;
