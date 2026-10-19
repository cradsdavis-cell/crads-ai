// telegram-drafts.mjs — what the Telegram bridge says about drafts (D4 default-deny).
//
// The 'message' job has no send tools, so a reply that would go out to someone
// else arrives as a DRAFT, marked by a final "PROPOSE-SEND: <summary>" line (the
// runner's prompt contract, shared with the voice page and every harness).
//
// This bridge used to hang Approve / Deny buttons on those drafts. Approve queued
// an 'execute-proposal' job that the runner only ever stubbed, and told the member
// "Approved, queued." Nothing was sent, and nothing said so. Until approval is
// wired to a real send path, the honest shape is: no buttons, and the draft says
// plainly that the member sends it.
export const DRAFT_FOOTER = "Here's the draft. Copy it and send it yourself.";

// The bot's first message once linked: the contract, in the same words as the docs
// (docs/product/pages/how-to/connect-telegram.md quotes it).
export const CONNECTED_GREETING =
  '✅ Connected. Message me any time. When something needs sending, I write the draft and you send it. I never send anything on my own.';

// A tap on a button left in the chat from before the buttons were removed.
export const STALE_BUTTON_REPLY = 'Nothing is sent from here. Copy the draft and send it yourself.';

const PROPOSE_LINE = /(^|\n)PROPOSE-SEND:[^\n]*/;
const PROPOSE_LINES = /(^|\n)PROPOSE-SEND:[^\n]*/g;

export const isDraft = (text) => PROPOSE_LINE.test(text || '');

// The sendMessage body for one outbox record. Never carries a reply_markup: there
// is no action behind a button, so there is no button.
export function outboundBody(rec) {
  const text = rec.text || '(no reply)';
  if (!isDraft(text)) return { chat_id: rec.chat_id, text };
  const body = text.replace(PROPOSE_LINES, '').trimEnd();
  return { chat_id: rec.chat_id, text: body ? `${body}\n\n${DRAFT_FOOTER}` : DRAFT_FOOTER };
}
