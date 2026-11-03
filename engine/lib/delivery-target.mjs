// delivery-target.mjs: where the box sends the owner something nobody asked for
// just now (a scheduled job's result, a health or custody warning, a dead
// Google sign-in). One answer for every writer of .kernel/outbox, so they can
// never disagree about which channel is the owner's.
//
// Two channels can carry it:
//   - Telegram (the default, and the only one before 2026-10-28): the bound chat
//     id in secrets/telegram_chat_id, written by connect-telegram.
//   - The owner's own Slack DM with their assistant (engine/comms/slack-dm.mjs),
//     configured by three files in secrets/: slack_app_token (xapp-),
//     slack_bot_token (xoxb-) and slack_owner_user (the owner's Slack user id).
//
// Which one is a setting the owner makes: .kernel/primary-channel holding the
// word `slack`. Anything else, an absent file, or a Slack bridge that is not
// configured, means Telegram, exactly as before. Read at every call, never
// cached, for the reason the scheduler learned the hard way: channels get
// connected while the scheduler is already running.
//
// A Slack target is the string `slack:<id>`. The prefix is the channel tag the
// two bridges key on: the Telegram bridge leaves every `slack:` record in the
// outbox alone, and the Slack bridge takes nothing else. Telegram chat ids are
// numbers (written as a number or as its digits), so no Telegram record can
// ever look like one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.mjs';

export const SLACK_PREFIX = 'slack:';
export const SLACK_SECRET_FILES = { app: 'slack_app_token', bot: 'slack_bot_token', owner: 'slack_owner_user' };

const readTrim = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };

export const isSlackTarget = (chatId) => typeof chatId === 'string' && chatId.startsWith(SLACK_PREFIX);
export const slackTargetId = (chatId) => (isSlackTarget(chatId) ? chatId.slice(SLACK_PREFIX.length) : '');

// The three Slack secrets, or null unless every one is there and has the right
// shape. A half-configured Slack is no Slack: the bridge does not start and
// nothing is routed to it.
export function readSlackSecrets(stateDir) {
  const dir = path.join(stateDir, 'secrets');
  const app = readTrim(path.join(dir, SLACK_SECRET_FILES.app));
  const bot = readTrim(path.join(dir, SLACK_SECRET_FILES.bot));
  const owner = readTrim(path.join(dir, SLACK_SECRET_FILES.owner));
  if (!/^xapp-/.test(app) || !/^xoxb-/.test(bot) || !/^[UW][A-Z0-9]{2,30}$/.test(owner)) return null;
  return { app, bot, owner };
}
export const slackConfigured = (stateDir) => !!readSlackSecrets(stateDir);

export const primaryChannelFile = (stateDir) => path.join(stateDir, '.kernel', 'primary-channel');
export function primaryChannel(stateDir) {
  return readTrim(primaryChannelFile(stateDir)).toLowerCase() === 'slack' && slackConfigured(stateDir) ? 'slack' : 'telegram';
}

// The chat id to stamp on an outbox record, or '' when the owner has no channel
// (the record is then not written at all). The Slack target is the owner's USER
// id: the Slack bridge posts it into the owner's DM with the bot, and it is the
// one id the bridge's outbound check always accepts.
export function deliveryTarget(stateDir) {
  if (primaryChannel(stateDir) === 'slack') return `${SLACK_PREFIX}${readSlackSecrets(stateDir).owner}`;
  return readTrim(path.join(stateDir, 'secrets', 'telegram_chat_id'));
}

// CLI, for start-comms.sh: `node delivery-target.mjs <state> slack-configured`
// exits 0 when the Slack DM bridge should run, 1 when it should not.
// `target` prints the delivery target (for an operator checking the setting).
if (isMain(import.meta.url)) {
  const [dir, verb] = process.argv.slice(2);
  const stateDir = path.resolve(dir || process.env.STATE_DIR || '.');
  if (verb === 'slack-configured') process.exit(slackConfigured(stateDir) ? 0 : 1);
  else if (verb === 'target') console.log(JSON.stringify({ primary: primaryChannel(stateDir), target: deliveryTarget(stateDir) }));
  else { console.error('usage: delivery-target.mjs <state> slack-configured|target'); process.exit(2); }
}
