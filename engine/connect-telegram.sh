#!/usr/bin/env bash
# connect-telegram — talk to your assistant from your phone.
#
# You make a private Telegram bot (takes a minute), paste its token here, send it a
# message, and you're connected. From then on you can message your assistant anywhere.
# It DRAFTS replies for you to approve — it never sends anything on its own.
set -euo pipefail
BOX="${STATE_DIR:-/state}"; SEC="$BOX/secrets"; mkdir -p "$SEC"
ENGINE="${ENGINE:-/app/engine}"
# The bot token rides curl's CONFIG on stdin, never its argv: an argv token is
# visible in `ps` to anything else on the box, and engine/comms/telegram-link.mjs
# already set that standard for this same secret. -K - reads the url from stdin.
# TELEGRAM_API_BASE matches the override telegram-link.mjs already honours, so
# tests can point this at a fake server instead of the real network.
tg(){ local _t="$1" _m="$2"; shift 2; printf 'url = "%s/bot%s/%s"\n' "${TELEGRAM_API_BASE:-https://api.telegram.org}" "$_t" "$_m" | curl -s -K - "$@"; }

echo "Step 1: make your bot (one minute):"
echo "  • In Telegram, open a chat with  @BotFather"
echo "  • Send  /newbot  and follow the prompts (pick any name)"
echo "  • It replies with a token like  123456789:ABCdef...  Copy it."
echo
printf "Paste your bot token: "; read -r TOKEN
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
[ -n "$TOKEN" ] || { echo "No token entered."; exit 1; }

# Same revoked-token gate the panel path uses (engine/comms/telegram-link.mjs),
# called rather than reimplemented so the two connect paths cannot disagree.
# FAIL CLOSED, not open. A box that has never revoked anything has nothing to
# enforce, so it stays connectable even if node is broken. But once something
# HAS been revoked, `set -euo pipefail` alone does not save this: if node were
# missing, check-revoked crashed, or the pipe produced no output, a plain
# `grep -q` finds no match either way and cannot tell "clean" from "did not
# run", so the script would fall through and accept the token. That is exactly
# the state an attacker still holding the old token is hoping for, so an
# indeterminate result must refuse the token too, not wave it through.
if [ -s "$SEC/telegram_revoked" ]; then
  CHECK_OUT="$(printf '%s' "$TOKEN" | base64 -w0 \
    | node "$ENGINE/comms/telegram-link.mjs" "$BOX" check-revoked 2>/dev/null)" || CHECK_OUT=""
  case "$CHECK_OUT" in
    *'"revoked":true'*)
      echo "That token was revoked on this mineral. Run /revoke in @BotFather to get a new one, then paste that."
      exit 1
      ;;
    *'"revoked":false'*)
      ;;
    *)
      echo "Could not confirm whether this token was revoked, so it was not accepted. Try again in a moment."
      exit 1
      ;;
  esac
fi

ME="$(tg "$TOKEN" getMe)"
echo "$ME" | grep -q '"ok":true' || { echo "That token didn't work. Re-check it with @BotFather and try again."; exit 1; }
BOTNAME="$(echo "$ME" | grep -oE '"username":"[^"]+"' | head -1 | cut -d'"' -f4)"
printf '%s' "$TOKEN" > "$SEC/telegram_bot_token"; chmod 600 "$SEC/telegram_bot_token"
echo "✓ Bot @$BOTNAME connected."
echo
# PAIRING CODE, NOT FIRST-COMER (2026-08-20 audit).
#
# This used to take the FIRST chat id in getUpdates. Bot usernames are globally
# searchable and BotFather names are guessable, and getUpdates replays up to 24
# hours of backlog, so any stranger who messaged the bot before you did became
# this box's trusted chat. That is not a cosmetic mistake: the bound chat is the
# whole isolation boundary in comms/telegram.mjs (its foreign-chat guard would
# then reject YOU), and policy.json has an auto_send lane for briefs and
# reminders to client_self over telegram, so unattended briefs generated from
# your own brain content would have been delivered to them.
#
# A code you have to send proves the sender is holding this terminal. We also
# require a private chat: a negative id is a group or channel, which is never
# "you".
PAIR="$(tr -dc 0-9 < /dev/urandom | head -c 6)"
echo "Step 2: open Telegram, find  @$BOTNAME, and send it exactly this code:"
echo
echo "      $PAIR"
echo
printf "Waiting for the code"
CHAT=""
for _ in $(seq 1 60); do
  # Parsed with node, not greps: the id and the text must come from the SAME
  # update, and matching them across a flat blob would pair anybody's id with
  # anybody's text and reopen the hole from the other side. Also requires a
  # private chat, so a group the bot was added to can never be "you".
  CHAT="$(tg "$TOKEN" getUpdates | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      let j = {};
      try { j = JSON.parse(raw); } catch { process.exit(0); }
      const want = process.argv[1];
      for (const u of (j.result || [])) {
        const m = u.message || u.channel_post || {};
        if (!m.chat || m.chat.type !== "private") continue;
        if (String(m.text || "").trim() !== want) continue;
        process.stdout.write(String(m.chat.id));
        return;
      }
    });
  ' "$PAIR" || true)"
  [ -n "$CHAT" ] && break
  printf "."; sleep 2
done
echo
[ -n "$CHAT" ] || { echo "Didn't see that code. Run  connect-telegram  again and send the code it prints."; exit 1; }
printf '%s' "$CHAT" > "$SEC/telegram_chat_id"; chmod 600 "$SEC/telegram_chat_id"
echo "✓ Linked to your chat."

# bring the bridge up now (no box restart needed)
bash "$ENGINE/start-comms.sh" "$BOX" 2>/dev/null || true
tg "$TOKEN" sendMessage -d chat_id="$CHAT" \
  -d text="✅ Connected to your AI OS. Message me anytime — I draft replies for you to approve, never send on my own." >/dev/null || true
echo
echo "✓ Done — Telegram is live. Message @$BOTNAME from your phone whenever you like."
echo "  (Heads up: it needs you signed into Claude in the box, and it spends your Claude usage per message.)"
