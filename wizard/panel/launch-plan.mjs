// launch-plan.mjs: what a packaged-app launch does before any server starts.
// Pulled out of wizard/app.mjs (2026-10-06) so the decision is testable.
//
//   'serve'    run the servers in THIS process (dev, CI, or the relaunched pebble)
//   'reopen'   another copy already answers: open a window at its URL and exit
//   'relaunch' respawn self detached and exit, so the server runs in the pebble
//
// Why macOS relaunches too (2026-10-06, a member force-quitting once or twice
// a day). The process LaunchServices starts from Crads-AI.app has no window of
// its own; the window is a Chrome --app window. While that process lives,
// macOS counts the app as running, so a second click on the icon only
// activates it (a reopen Apple Event a node process never handles) and NO new
// process starts. The single-instance check that reopens the window never
// ran, and the click did nothing until the member force quit. Login made it
// worse: "reopen windows when logging back in" relaunched the windowless
// process. When the launched process exits straight after handing off to a
// detached pebble, macOS sees the app quit, and every click is a fresh launch
// that reaches the reopen path. Windows has relaunched since the console-hide
// fix; the two platforms now share one shape.
export function launchPlan({ platform, sea, env = {}, live = false }) {
  if (!sea || env.AIOS_NO_LAUNCH === '1') return 'serve';
  if (platform !== 'win32' && platform !== 'darwin') return 'serve';
  if (live) return 'reopen';
  if (env.AIOS_RELAUNCHED) return 'serve';
  return 'relaunch';
}
