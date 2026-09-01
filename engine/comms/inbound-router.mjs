#!/usr/bin/env node
// inbound-router.mjs — per-client inbound isolation (spec §3.P6.X.live, gate G6).
//
// Each client box runs its OWN telegram adapter against its OWN bot token, so an inbound
// message reaches exactly one box by construction. This module is the single source of the
// two isolation invariants that make "A-addressed -> only A" true, shared by the live adapter
// (telegram.mjs) and the harness so they can never drift:
//
//   decideRoute(allowedChatId, inboundChatId):
//     - 'accept'          iff the message is from the box's OWN client chat
//     - 'reject-foreign'  otherwise  (default-deny: a client's private bot ignores other chats —
//                          so even a mis-delivered / spoofed chat cannot drive another client's box)
//
//   routeInbound(boxes, inbound): resolve the bot_token -> the owning box, apply decideRoute,
//     and enqueue a 'message' job into THAT box's queue ONLY (reply_to = the inbound chat).
//     Unknown bot -> dropped. Foreign chat -> dropped. Never fans out to a second box.
import path from 'node:path';
import { enqueue } from '../kernel/lib/queue.mjs';

export function decideRoute(allowedChatId, inboundChatId) {
  return String(allowedChatId) === String(inboundChatId) ? 'accept' : 'reject-foreign';
}

// boxes: [{ box_id, state_dir, bot_token, allowed_chat_id }]
// inbound: { bot_token, chat_id, text }
export async function routeInbound(boxes, inbound) {
  const owner = boxes.find((b) => b.bot_token === inbound.bot_token);
  if (!owner) return { routed: null, reason: 'unknown-bot' };
  if (decideRoute(owner.allowed_chat_id, inbound.chat_id) === 'reject-foreign')
    return { routed: null, reason: 'foreign-chat-rejected', box: owner.box_id };
  const { id } = await enqueue(owner.state_dir, { skill: 'message', args: { text: inbound.text }, reply_to: inbound.chat_id, source: 'telegram' });
  return { routed: owner.box_id, job_id: id };
}
