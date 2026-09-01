# Sources for the hand-sourced marks

simple-icons 16.28.0 (CC0-1.0, see LICENSE) covers 43 of the 66 marks. The 23
below were not in that package and were fetched by hand (17 on 2026-08-23, the
six note-takers on 2026-08-24), in this order of preference: the vendor's own
brand kit, the vendor's own favicon, the vendor's GitHub organisation avatar. Every file was reduced to a 24x24 viewBox
(SVG) or 32 to 64 px (PNG, under 6 KB); gradients and clip paths were dropped
because the panel CSP test forbids `url(`. "mask" means a single-colour SVG the
panel tints with `hex`; "img" means the file is shown as-is (multi-colour SVG
or PNG). All of these are the vendors' trademarks, used only to identify a
connection to that vendor's service (nominative use); none of the vendors
publishes a licence for the mark, and the terms quoted are their stated
guidelines, which govern any use beyond that.

| key | source | format / render | terms noted | hex | fetched |
|---|---|---|---|---|---|
| canva | Canva Connect brand guidelines, https://www.canva.dev/docs/connect/guidelines/brand/ ; file `Canva Icon logo.svg` from https://www.canva.dev/assets/connect/Canva-logos.zip | svg, mask (the radial gradients dropped; disc + C as one even-odd path) | "For surfaces below 50px, use the icon logo." Do not alter colours or shape; must not imply endorsement. | #7D2AE7 (the icon's base fill) | 2026-08-23 |
| apify | Apify brand page, https://apify.com/resources/brand ; file https://apify.com/img/apify-logo/apify-symbol-200x200.svg | svg, img (three-colour symbol kept as drawn) | "Always provide plenty of space around Apify assets." | #20A34E (green; also #F86606, #246DFF) | 2026-08-23 |
| context7 | Context7 site logo (symbol + wordmark), https://context7.com/_next/static/media/context7-logo-light.99ff21c1.svg ; symbol cut from it (no brand page; Upstash's brand page at https://upstash.com/brand has no Context7 asset) | svg, mask (rounded square with the four quote glyphs cut out, even-odd) | none stated | #000000 (as drawn) | 2026-08-23 |
| semgrep | Semgrep site favicon, https://semgrep.dev/build/assets/favicon-CIx-xpG_.svg (no brand page; press is a mailto) | svg, mask | none stated | #13BF95 (the favicon's fill) | 2026-08-23 |
| globalping | Globalping site favicon, https://globalping.io/icons/favicon.svg (no brand page; jsDelivr's media repo carries no Globalping asset) | svg, mask | jsDelivr media README (for the jsDelivr logo): do not create modified versions; do not use as your own app icon | #17D4A7 (the favicon's fill) | 2026-08-23 |
| heroku | Heroku brand guidelines, https://devcenter.heroku.com/articles/heroku-brand-guidelines ; file `Heroku Logo Mark/Light/Heroku-Logo-Mark-Light-RGB.svg` from https://devcenter3.assets.heroku.com/article-images/heroku-logos.zip | svg, mask | Mark alone only where the Heroku brand is obvious (avatars, product dials); do not skew, mask or recolour; commercial use via brand@heroku.com | #5A1BA9 (Heroku Purple, stated) | 2026-08-23 |
| exa | Exa brand page, https://exa.ai/brand ; file `Logo/SVGs/Logomark/Exa Logomark Blue.svg` from https://exa.ai/assets/Exa%20Brand%20Assets.zip | svg, mask | guidelines for partners/developers on displaying the trademarks; co-branded material needs approval | #1840ED (Exa blue, stated) | 2026-08-23 |
| amplitude | GitHub organisation avatar, https://github.com/amplitude.png?size=64 (brand page https://brand.amplitude.com/visual-direction/logo offers files only via a Google Drive folder) | png 64px, img | "Do not skew, distort or rotate... Do not add effects or recolor." | #0052F2 (the avatar's ground) | 2026-08-23 |
| close | Close brand page, https://close.com/brand ; file `mark.svg` from https://resource-downloads.close.com/resources/close-logo-2024.zip | svg, img (three-colour mark kept as drawn; no-op clip path dropped) | Use only the images provided on the page; do not modify; do not imply affiliation | #1463FF (the mark's blue) | 2026-08-23 |
| attio | Attio site favicon, https://attio.com/favicon.ico (ICO 32px, converted to PNG with Pillow; no public brand page) | png 32px, img | none stated | #000000 (the glyph) | 2026-08-23 |
| plaid | Plaid site favicon, https://plaid.com/assets/img/favicons/favicon-32x32.png (no brand page; the GitHub avatar is over 6 KB) | png 32px, img | none stated | #0DAAEF (the favicon's ground) | 2026-08-23 |
| klaviyo | GitHub organisation avatar, https://github.com/klaviyo.png?size=64 (logo files are on the login-gated partner portal) | png 64px, img | none public | #232426 (the avatar's ground) | 2026-08-23 |
| readwise | GitHub organisation avatar, https://github.com/readwiseio.png?size=64 (no brand page) | png 64px, img | none stated | #000000 (the glyph) | 2026-08-23 |
| honeycomb | GitHub organisation avatar, https://github.com/honeycombio.png?size=64 (no brand page) | png 64px, img | none stated | #64BA00 (a hex cell's fill) | 2026-08-23 |
| stytch | Stytch site favicon, https://stytch.com/favicon.ico (a 32px PNG; the GitHub avatar is the wordmark, not the symbol; no brand page) | png 32px, img | none stated | #1D1D1D (the glyph) | 2026-08-23 |
| workos | GitHub organisation avatar, https://github.com/workos.png?size=64 (no brand page) | png 64px, img | none stated | #6363F1 (the avatar's ground) | 2026-08-23 |
| polar | Polar brand page, https://polar.sh/brand ; the icon SVG is inline on the page (the "Copy icon SVG" control) | svg, mask | "Reproduce them in full white on dark or full black on light. Never recolor, rotate, or distort the mark." Min 16px. | #090909 (Night, stated; the renderer lightens it on dark) | 2026-08-23 |
| otter | Otter.ai site apple-touch-icon, https://otter.ai/ -> https://cdn.prod.website-files.com/618e9316785b3582a5178502/618e943a80919a98b5e9bf69_apple-icon.png (no public brand page) | png 64px, img | none stated | #0078FF (the waveform) | 2026-08-24 |
| fireflies | Fireflies.ai site icon, https://fireflies.ai/icon.png (declared `rel=icon` 512x512; no public brand page) | png 64px, img | none stated | #CF3487 (the mark's magenta) | 2026-08-24 |
| granola | Granola site favicon, https://www.granola.ai/favicon/favicon-96x96.png (the sibling favicon.svg is a RealFaviconGenerator wrapper around the same raster, so the png is the honest source) | png 64px, img | none stated | #B2C248 (the tile ground) | 2026-08-24 |
| avoma | Avoma site apple-touch-icon, https://www.avoma.com/ -> https://cdn.prod.website-files.com/5de236b4d41434460ade73ac/5de60e45eee20578cc43a906_Avoma-Icon-Color-256.png (no public brand page) | png 64px, img | none stated | #FF5740 (the tile ground) | 2026-08-24 |
| krisp | Krisp site favicon, https://krisp.ai/wp-content/uploads/2023/12/cropped-favicon-1-192x192.png (no public brand page) | png 64px, img | none stated | #131032 (the K) | 2026-08-24 |
| fyxer | Fyxer site favicon, https://www.fyxer.com/favicon.ico (ICO 32px, converted with Pillow; no public brand page) | png 64px, img | none stated | #FF5B3A (the F) | 2026-08-24 |

**Why these six came from vendor domains, not GitHub avatars.** The 2026-08-23
batch used GitHub organisation avatars as a third-choice source. For the
note-takers that source is unsafe: of the six orgs whose names matched, only
`otter-ai` (name "Otter.ai, Inc.", blog otter.ai) and `krispai` are verifiably
the vendor. `fireflies-ai`, `avoma` and `fyxer` carry no name and no blog, and
`fireflies-ai`'s avatar (a teal robot) does not resemble the magenta mark
fireflies.ai actually serves, so it is somebody else's account. Every mark above
was therefore taken from the vendor's own domain, which is self-authenticating.
