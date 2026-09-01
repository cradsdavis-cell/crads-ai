// nav.mjs — the one way a shots rig reaches a tab.
//
// Since 2026-08-04 the sidebar's tabs live inside `.navgroup`s that are
// COLLAPSED by default (`groupsApply()` in member.html hides `.gitems`, and a
// fresh browser context has no `crads-nav-groups` in localStorage). So
// `page.click('#nav button[data-sec="brain"]')` on a freshly opened page finds
// the button in the DOM, waits 30s for it to become visible, and dies:
//
//   page.click: Timeout 30000ms exceeded ... element is not visible
//
// Three of the four rigs grew their own answer to this and one did not, which
// is how `shots.mjs` sat at "2 shot(s) failed" (member-brain, both themes) on
// the shipping tip. A permanent non-zero failure count is a failure count
// nobody reads, which is exactly where the next real regression lands, and it
// is the same lesson `shot-selectors.test.mjs` was written for.
//
// The grouping is DERIVED from the live page (`closest('.navgroup')`), never
// from a hand-kept sec -> group map. panel-shots.mjs kept such a map and its
// own comment records it going stale once already ("group ids: 'automations'
// became 'assistant' on 2026-08-10"). A map has to be edited when the nav is
// regrouped; asking the DOM cannot rot.
//
// The header is opened with a REAL click, the way a person opens it, rather
// than by writing localStorage or toggling the class: the shot is evidence
// about the shipping page, so every state in it has to be reachable by hand.

/**
 * Open the group owning `sec`, if it has one and it is shut.
 * @returns {Promise<string|null>} the group id opened, or null if there was
 *   nothing to open (top-level tab, or already open).
 */
export async function openGroupFor(page, sec) {
  const group = await page.evaluate((s) => {
    const b = document.querySelector(`#nav button[data-sec="${s}"]`);
    const g = b && b.closest('.navgroup');
    if (!g || g.classList.contains('open')) return null;
    return g.getAttribute('data-group');
  }, sec);
  if (!group) return null;
  await page.click(`#nav button[data-group-toggle="${group}"]`);
  await page.waitForSelector(`#nav .navgroup[data-group="${group}"].open`, { timeout: 5000 });
  return group;
}

/** Open the owning group if needed, click the tab, settle for `extraMs`. */
export async function navTo(page, sec, extraMs = 1200) {
  await openGroupFor(page, sec);
  await page.click(`#nav button[data-sec="${sec}"]`);
  await page.waitForTimeout(extraMs);
}

/** `navTo` shaped as a shot's `after` hook: `after: nav('brain', 3500)`. */
export const nav = (sec, extraMs = 1200) => (page) => navTo(page, sec, extraMs);
