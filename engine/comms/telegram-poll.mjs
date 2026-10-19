// telegram-poll.mjs: one turn of the Telegram bridge loop, and the back-off it
// keeps when Telegram refuses the bot token. Split out of telegram.mjs (which
// starts polling the moment it is imported) so a test can drive it with a fake
// fetch and a fake clock.
//
// Why it exists (trap 71). getUpdates only long-polls when the token is good. A
// refused token gets an instant 401 (or 404 for a malformed one), and the loop
// used to go straight round again: the 2026-10-14 drill logged 1,377 refusals in
// about 47 seconds. A member whose bot token was revoked would hammer Telegram
// the same way until it rate-limited or blocked the server's address. Now a
// refusal waits 5 s, doubling to a 10 minute cap, logs once per wait, and the
// caller re-reads the token file before the next try, so a corrected token works
// without a restart.

export const TOKEN_BACKOFF_FIRST_MS = 5_000;
export const TOKEN_BACKOFF_CAP_MS = 10 * 60_000;
// Any other refusal (409 two pollers, 5xx) waits this long, the same as a
// network error in the caller's catch. 429 waits as long as Telegram asks.
export const OTHER_FAILURE_MS = 3_000;

// The Bot API as a function of a token that can change under it. `fetchImpl` is
// injectable for tests; production passes the global fetch.
export function makeApi({ base, getToken, fetchImpl = fetch }) {
  const root = String(base || 'https://api.telegram.org').replace(/\/+$/, '');
  return async (method, body) => {
    const r = await fetchImpl(`${root}/bot${getToken()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  };
}

// 401 is a revoked or wrong token, 404 a malformed one. Either way nothing
// changes until somebody fixes the token, so retrying fast only burns requests.
export const isTokenRefused = (res) => res?.ok === false && (res.error_code === 401 || res.error_code === 404);

export function tokenBackoff({ firstMs = TOKEN_BACKOFF_FIRST_MS, capMs = TOKEN_BACKOFF_CAP_MS } = {}) {
  let failures = 0;
  return {
    get failures() { return failures; },
    next() { const ms = Math.min(firstMs * 2 ** failures, capMs); failures += 1; return ms; },
    reset() { const n = failures; failures = 0; return n; },
  };
}

export const humanDelay = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

// One turn: poll, then handle what came back. Returns how long the caller should
// wait before the next turn (0 means go straight on) and whether the wait is a
// token refusal, after which the caller re-reads the token file.
export async function pollTurn({ api, offset, handleUpdates, flushOutbox, backoff, log }) {
  const res = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  if (isTokenRefused(res)) {
    const waitMs = backoff.next();
    // Logged once per wait, so at worst once per back-off step.
    log(`getUpdates: Telegram refused the bot token (${res.error_code}: ${res.description}). Retrying in ${humanDelay(waitMs)}; a corrected token is picked up without a restart.`);
    // No outbox flush: sendMessage would be refused with the same token.
    return { waitMs, tokenRefused: true };
  }
  const refusals = backoff.reset();
  if (refusals) log(`getUpdates: the bot token works again after ${refusals} refused ${refusals === 1 ? 'attempt' : 'attempts'}.`);
  if (!res?.ok) {
    const retryAfter = Number(res?.parameters?.retry_after);
    const waitMs = res?.error_code === 429 && retryAfter > 0 ? retryAfter * 1000 : OTHER_FAILURE_MS;
    log(`getUpdates: ${res?.description ?? 'no description'}. Retrying in ${humanDelay(waitMs)}.`);
    return { waitMs, tokenRefused: false };
  }
  await handleUpdates(res.result || []);
  await flushOutbox();
  return { waitMs: 0, tokenRefused: false };
}
