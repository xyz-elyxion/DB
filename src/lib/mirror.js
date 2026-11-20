import { ChannelType } from "discord.js";
import { splitContent, webhookName } from "./messages.js";

const MIRRORED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const HOOK_NAME = "Server mirror";
const MAX_FILES = 10;

/** Channel types whose messages can be mirrored into the other server. */
export function canMirrorChannel(channel) {
  return Boolean(channel) && MIRRORED_CHANNEL_TYPES.has(channel.type);
}

/** Find the target channel that mirrors a source channel: same name, same type. */
export function findMirrorChannel(sourceChannel, targetGuild) {
  const channels = targetGuild?.channels?.cache;
  if (!sourceChannel || !channels) return null;

  const name = (sourceChannel.name ?? "").toLowerCase();
  const matches = [...channels.values()].filter(
    (channel) =>
      channel.type === sourceChannel.type && (channel.name ?? "").toLowerCase() === name,
  );
  if (matches.length === 0) return null;

  // Same name in two categories: prefer the one in the matching category.
  if (sourceChannel.parent) {
    const sameCategory = matches.find(
      (channel) => channel.parent?.name === sourceChannel.parent.name,
    );
    if (sameCategory) return sameCategory;
  }

  return matches[0];
}

/** Everything that should not be forwarded: bots, webhooks, system notes, noise. */
export function shouldMirror(message) {
  if (!message || !message.guild) return false;
  if (message.system || message.webhookId) return false;
  if (message.author?.bot) return false;
  if (message.member?.user?.bot) return false;
  if (!canMirrorChannel(message.channel)) return false;

  const hasContent = Boolean(message.content && message.content.trim().length > 0);
  const hasFiles = (message.attachments?.size ?? 0) > 0;
  return hasContent || hasFiles;
}

async function webhookFor(channel, client, hooks) {
  const cached = hooks.get(channel.id);
  if (cached) return cached;

  const hooksInChannel = await channel.fetchWebhooks?.().catch(() => null);
  const existing =
    hooksInChannel?.find?.(
      (candidate) => candidate.name === HOOK_NAME && candidate.owner?.id === client?.user?.id,
    ) ?? null;

  const webhook =
    existing ??
    (await channel.createWebhook({ name: HOOK_NAME, reason: "Mirroring new messages" }));

  hooks.set(channel.id, webhook);
  return webhook;
}

/** The webhook payload for one chunk of a message. */
export function webhookPayload(message, content, withFiles = false) {
  const files = withFiles
    ? [...(message.attachments?.values?.() ?? [])].slice(0, MAX_FILES).map((file) => file.url)
    : [];

  return {
    content: content ?? "",
    username: webhookName(message.member ?? { user: message.author }),
    avatarURL: message.author?.displayAvatarURL?.({ size: 128 }) ?? undefined,
    files,
    allowedMentions: { parse: [] },
  };
}

/**
 * Repost one new message from the source server into the matching channel of the
 * target server, through a webhook so it keeps the author's name and avatar.
 * Returns `{ mirrored: false, reason }` when there was nothing to do.
 */
export async function mirrorMessage({ message, targetGuild, client, hooks = new Map() }) {
  if (!shouldMirror(message)) return { mirrored: false, reason: "ignored" };

  const targetChannel = findMirrorChannel(message.channel, targetGuild);
  if (!targetChannel) return { mirrored: false, reason: "no matching channel" };

  const chunks = splitContent(message.content);
  const messageIds = [];
  const sendAll = async (webhook) => {
    const [first, ...rest] = chunks;
    const sent = await webhook.send(webhookPayload(message, first, true));
    if (sent?.id) messageIds.push(sent.id);
    for (const chunk of rest) {
      const extra = await webhook.send(webhookPayload(message, chunk));
      if (extra?.id) messageIds.push(extra.id);
    }
  };

  let webhook = await webhookFor(targetChannel, client, hooks);
  try {
    await sendAll(webhook);
  } catch (error) {
    // A webhook deleted by hand answers 404/10015; make a fresh one and retry once.
    hooks.delete(targetChannel.id);
    webhook = await webhookFor(targetChannel, client, hooks);
    await sendAll(webhook);
  }

  return {
    mirrored: true,
    channel: targetChannel.name,
    chunks: Math.max(1, chunks.length),
    messageIds,
    webhook,
  };
}
