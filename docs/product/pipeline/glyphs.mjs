// glyphs.mjs - the small line icons the docs index draws on its doors.
//
// Same rules as diagrams.mjs, for the same reasons: hand-authored inline SVG,
// zero dependencies, and every stroke is `currentColor` so a glyph inherits
// whatever colour the card gives it and can never carry a palette of its own.
// 24x24 viewBox, one or two strokes each, decorative (aria-hidden): the door's
// title carries the meaning, the glyph only helps the eye find it.

const G = {
  // deciding: a compass
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13.6 13.6 8.5 15.5 10.4 10.4z"/>',
  // setting up: a server with a light
  server: '<rect x="4" y="5" width="16" height="6" rx="1.5"/><rect x="4" y="13" width="16" height="6" rx="1.5"/><path d="M8 8h.01M8 16h.01"/>',
  // real work: a bolt
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  // reach: an envelope
  envelope: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m3 8 9 6 9-6"/>',
  // safe and yours: a shield
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9.5 12 2 2 3.5-4"/>',
  // fixing: a wrench
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L9 22l-3-3L16.5 8.5A4 4 0 0 0 14.5 6.5z"/><path d="M14.5 6.5 19 2"/>',
};

export const glyphIds = () => Object.keys(G);

export function glyph(id) {
  const body = G[id];
  if (!body) return null;
  return `<svg class="glyph" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
