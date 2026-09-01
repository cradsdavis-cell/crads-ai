#!/usr/bin/env node
// make-icon.mjs <out.ico>: generates the Crads-AI app icon at build time (no
// binary blobs in git). Pure node (zlib + math): draws the mark as RGBA pixels,
// wraps each size as a PNG, and packs PNG-in-ICO (Vista+; fine on Win10/11).
//
// The mark (2026-08-04, site-brand alignment): the crads-ai.com circuit-leaf on
// a cream rounded badge. A leaf outline whose veins are circuit traces ending in
// via-rings, one node filled terracotta. Palette is the site's exactly
// (lib/site.css): cream #FAF7EE, deep green #173D2A, terracotta #C2703D /
// #A4582C. Detail sheds with size: 16px keeps outline + midrib + the node.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'crads-ai.ico';
const SIZES = [256, 48, 32, 16];

// ---------------------------------------------------------------- drawing
const CREAM = [0xfa, 0xf7, 0xee], GREEN = [0x17, 0x3d, 0x2a];
const TERRA = [0xc2, 0x70, 0x3d], TERRA_DEEP = [0xa4, 0x58, 0x2c];
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// coverage from a signed distance (px): 1 inside, 0 outside, soft 1px edge
const cov = (d) => clamp01(0.5 - d);
// distance from point (px,py) to segment a->b
function segDist(pxx, pyy, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((pxx - ax) * abx + (pyy - ay) * aby) / (abx * abx + aby * aby || 1));
  return Math.hypot(pxx - (ax + abx * t), pyy - (ay + aby * t));
}

// The leaf's numbers for a given canvas size — shared by the raster drawing
// (draw) and the vector emitter (--svg) so the two can never drift.
function geometry(s) {
  const cx = s / 2;
  const t = Math.max(1.1, s * 0.042);   // trace/outline stroke width
  // leaf: a vesica (two-circle intersection), tips at yT / yB on the centreline
  const yT = s * 0.13, yB = s * 0.83, yC = (yT + yB) / 2;
  const h = yB - yT, w = s * 0.235;     // half-height span + half-width at the waist
  const d = (h * h / 4 - w * w) / (2 * w);
  const r = d + w;                      // vesica circle radius (centres at cx +- d)
  // local half-width of the leaf at height y (0 outside the tips)
  const hw = (y) => Math.max(0, Math.sqrt(Math.max(0, r * r - (y - yC) * (y - yC))) - d);
  // circuit veins: [start fraction along yT..yB, side, tip at this fraction of
  // the LOCAL half-width, rise /s, cap]. Tips are computed from the leaf's own
  // width so rings always land inside; the terracotta node runs to the edge and
  // overlaps the outline, as on the site mark. Detail sheds with size.
  const veins = [];
  if (s >= 40) {
    veins.push([0.30, +1, 0.94, 0.06, 'node'],
      [0.40, -1, 0.72, 0.11, 'ring'], [0.52, +1, 0.74, 0.12, 'ring'],
      [0.62, -1, 0.74, 0.13, 'ring'], [0.74, +1, 0.72, 0.14, 'ring'],
      [0.84, -1, 0.68, 0.15, 'ring']);
  } else if (s >= 24) {
    veins.push([0.32, +1, 0.94, 0.05, 'node'], [0.50, -1, 0.70, 0.11, 'ring'], [0.70, +1, 0.70, 0.13, 'ring']);
  } else {
    veins.push([0.32, +1, 0.94, 0.05, 'node']);
  }
  const ringR = Math.max(1.2, s * 0.036);
  const nodeR = Math.max(1.6, s * 0.054);
  // resolved vein endpoints: {ax,ay, ex,ey (trace end), tipX,tipY, cap}
  const resolved = veins.map(([f, side, frac, rise, cap]) => {
    const ay = yT + (yB - yT) * f;
    const tipY = ay - rise * s;
    const tipX = cx + side * frac * hw(tipY);
    const vx = tipX - cx, vy = tipY - ay, vl = Math.hypot(vx, vy) || 1;
    const capR = cap === 'node' ? nodeR : ringR;
    return { ax: cx, ay, ex: tipX - (vx / vl) * capR, ey: tipY - (vy / vl) * capR, tipX, tipY, cap };
  });
  return { cx, t, yT, yB, yC, d, r, hw, veins: resolved, ringR, nodeR };
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size;
  const corner = s * 0.22;              // rounded-square corner radius
  const half = s / 2 - Math.max(1, s * 0.02);
  const { cx, t, yT, yB, yC, d, r, veins, ringR, nodeR } = geometry(s);

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const p = (y * s + x) * 4;
      const X = x + 0.5, Y = y + 0.5;
      const dx = X - cx, dy = Y - s / 2;

      // cream rounded-square badge (SDF)
      const qx = Math.abs(dx) - (half - corner), qy = Math.abs(dy) - (half - corner);
      const bgD = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      const aBg = cov(bgD);
      if (aBg <= 0) continue;           // fully transparent

      // green coverage accumulates across leaf outline + midrib + veins + rings
      let g = 0;
      // leaf outline: |vesica sdf| stroked
      const leafSdf = Math.max(Math.hypot(X - (cx - d), Y - yC), Math.hypot(X - (cx + d), Y - yC)) - r;
      g = Math.max(g, cov(Math.abs(leafSdf) - t / 2));
      // midrib: centreline from just below the top tip through the bottom tip
      g = Math.max(g, cov(segDist(X, Y, cx, yT + s * 0.07, cx, yB) - t / 2));

      let terra = 0, terraDeep = 0;
      for (const { ax, ay, ex, ey, tipX, tipY, cap } of veins) {
        // trace stops short of the cap so open rings read as circuit vias
        g = Math.max(g, cov(segDist(X, Y, ax, ay, ex, ey) - t / 2));
        const cd = Math.hypot(X - tipX, Y - tipY);
        if (cap === 'ring') g = Math.max(g, cov(Math.abs(cd - ringR) - t / 2));
        else {                          // the terracotta node: filled disc + deep ring
          terra = Math.max(terra, cov(cd - nodeR));
          terraDeep = Math.max(terraDeep, cov(Math.abs(cd - nodeR) - t / 2));
        }
      }

      let c = CREAM;
      if (g > 0) c = [c[0] + (GREEN[0] - c[0]) * g, c[1] + (GREEN[1] - c[1]) * g, c[2] + (GREEN[2] - c[2]) * g];
      if (terra > 0) c = [c[0] + (TERRA[0] - c[0]) * terra, c[1] + (TERRA[1] - c[1]) * terra, c[2] + (TERRA[2] - c[2]) * terra];
      if (terraDeep > 0) c = [c[0] + (TERRA_DEEP[0] - c[0]) * terraDeep, c[1] + (TERRA_DEEP[1] - c[1]) * terraDeep, c[2] + (TERRA_DEEP[2] - c[2]) * terraDeep];
      px[p] = Math.round(c[0]); px[p + 1] = Math.round(c[1]); px[p + 2] = Math.round(c[2]);
      px[p + 3] = Math.round(aBg * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG writer
const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1)); // filter byte 0 per scanline
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- --svg mode
// make-icon.mjs --svg: print the mark as a 64-viewBox inline SVG for the brand
// lockups (door / wizard / join page). Same geometry() as the raster icon, so
// the lockup and the taskbar icon cannot drift apart. The badge rect carries no
// stroke here; the pages style it with their own var(--line-2) hairline.
if (process.argv[2] === '--svg') {
  const s = 64;
  const { cx, t, yT, yB, yC, d, r, veins, ringR, nodeR } = geometry(s);
  const n = (v) => +v.toFixed(2);
  const G = '#173D2A', el = [];
  el.push(`<rect x="1" y="1" width="62" height="62" rx="14" fill="#FAF7EE"/>`);
  el.push(`<path d="M${n(cx)} ${n(yT)} A${n(r)} ${n(r)} 0 0 1 ${n(cx)} ${n(yB)} A${n(r)} ${n(r)} 0 0 1 ${n(cx)} ${n(yT)} Z" fill="none" stroke="${G}" stroke-width="${n(t)}" stroke-linejoin="round"/>`);
  el.push(`<line x1="${n(cx)}" y1="${n(yT + s * 0.07)}" x2="${n(cx)}" y2="${n(yB)}" stroke="${G}" stroke-width="${n(t)}" stroke-linecap="round"/>`);
  for (const { ax, ay, ex, ey, tipX, tipY, cap } of veins) {
    el.push(`<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(ex)}" y2="${n(ey)}" stroke="${G}" stroke-width="${n(t)}" stroke-linecap="round"/>`);
    if (cap === 'ring') el.push(`<circle cx="${n(tipX)}" cy="${n(tipY)}" r="${n(ringR)}" fill="none" stroke="${G}" stroke-width="${n(t)}"/>`);
    else el.push(`<circle cx="${n(tipX)}" cy="${n(tipY)}" r="${n(nodeR)}" fill="#C2703D" stroke="#A4582C" stroke-width="${n(t)}"/>`);
  }
  console.log([`<svg class="mark" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`, ...el.map((e) => '      ' + e), '    </svg>'].join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------- .iconset mode (macOS)
// make-icon.mjs --iconset <dir>: emit the PNG set `iconutil -c icns <dir>` expects.
// Same mark, same palette; the drawing is size-parametric so retina sizes are free.
if (process.argv[2] === '--iconset') {
  const dir = process.argv[3] || 'crads-ai.iconset';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const wanted = [[16, ''], [16, '@2x'], [32, ''], [32, '@2x'], [128, ''], [128, '@2x'], [256, ''], [256, '@2x'], [512, ''], [512, '@2x']];
  for (const [base, suffix] of wanted) {
    const real = suffix ? base * 2 : base;
    writeFileSync(`${dir}/icon_${base}x${base}${suffix}.png`, png(real, draw(real)));
  }
  console.log(`iconset: ${dir} (10 pngs, 16..1024 px)`);
  process.exit(0);
}

// ---------------------------------------------------------------- ICO container
const pngs = SIZES.map((s) => png(s, draw(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);              // type: icon
header.writeUInt16LE(SIZES.length, 4);
let offset = 6 + 16 * SIZES.length;
const entries = [];
for (let i = 0; i < SIZES.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = SIZES[i] === 256 ? 0 : SIZES[i];
  e[1] = SIZES[i] === 256 ? 0 : SIZES[i];
  e.writeUInt16LE(1, 4);                 // planes
  e.writeUInt16LE(32, 6);                // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}
writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs]));
console.log(`icon: ${OUT} (${SIZES.join('/')} px, ${offset} bytes)`);
