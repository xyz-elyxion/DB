import { sleep } from "./errors.js";

const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

/** Split message content into chunks Discord will accept (2000 characters). */
export function splitContent(content, max = 2000) {
  const text = content ?? "";
  if (text.length <= max) return text ? [text] : [];

  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.6) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.6) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Webhook names can't contain "discord" or "clyde" and max out at 32 chars. */
export function webhookName(member) {
  const raw = (member?.displayName ?? member?.user?.username ?? "member").replace(/clyde|discord/gi, "member");
  return raw.trim().slice(0, 32) || "member";
}

async function downloadAttachments(message) {
  const files = [];
  if (!message.attachments?.size) return files;

  let total = 0;
  for (const attachment of [...message.attachments.values()].slice(0, MAX_ATTACHMENTS)) {
    if (attachment.size && total + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) continue;
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      total += buffer.byteLength;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) break;
      files.push({ attachment: buffer, name: attachment.name ?? "file" });
    } catch {
      // A dead CDN link shouldn't stop the rest of the message.
    }
  }
  return files;
}

/**
 * Replay the most recent messages of a source channel into a target channel
 * through a temporary webhook, so each message keeps its author's name and
 * avatar instead of looking like a bot dump.
 */
export async function copyChannelMessages({ sourceChannel, targetChannel, limit = 25, reason }) {
  let fetched;
  try {
    fetched = await sourceChannel.messages.fetch({ limit });
  } catch (error) {
    return { copied: 0, skipped: 0, error: `couldn't read messages (${error.message})` };
  }

  const messages = [...fetched.values()]
    .filter(
      (message) =>
        !message.system &&
        ((message.content && message.content.trim().length > 0) ||
          (message.attachments?.size ?? 0) > 0 ||
          (message.embeds?.length ?? 0) > 0),
    )
    .reverse();

  const skipped = fetched.size - messages.length;
  if (messages.length === 0) return { copied: 0, skipped, error: null };

  if (typeof targetChannel.createWebhook !== "function") {
    return { copied: 0, skipped: fetched.size, error: "can't create a webhook in this channel" };
  }

  const webhook = await targetChannel.createWebhook({
    name: "Replicated messages",
    reason,
  });

  let copied = 0;
  try {
    for (const message of messages) {
      const chunks = splitContent(message.content);
      if (chunks.length === 0) chunks.push("");
      const [first, ...rest] = chunks;
      const files = await downloadAttachments(message);
      const embeds = [...(message.embeds ?? [])].slice(0, 10);

      await webhook.send({
        content: first,
        username: webhookName(message.member ?? { user: message.author }),
        avatarURL: message.author?.displayAvatarURL?.({ size: 128 }) ?? undefined,
        files,
        embeds,
        allowedMentions: { parse: [] },
      });

      for (const chunk of rest) {
        await webhook.send({
          content: chunk,
          username: webhookName(message.member ?? { user: message.author }),
          avatarURL: message.author?.displayAvatarURL?.({ size: 128 }) ?? undefined,
          allowedMentions: { parse: [] },
        });
      }

      copied += 1;
      await sleep(300);
    }
  } finally {
    await webhook.delete(reason).catch(() => {});
  }

  return { copied, skipped, error: null };
}
