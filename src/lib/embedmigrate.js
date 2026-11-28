import { ChannelType } from "discord.js";
import { restyleEmbeds } from "./embeds.js";

export const DEFAULT_SCAN_LIMIT = 100;
const MAX_ARCHIVED_PAGES = 20;

const SCANNABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

const isForum = (channel) =>
  channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchMessages(channel, limit) {
  if (typeof channel?.messages?.fetch !== "function") return [];
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return [];
  return [...(fetched.values?.() ?? fetched)];
}

/** Every post in a forum, archived ones included, so old cards are not missed. */
async function forumThreads(channel) {
  const found = new Map();
  if (typeof channel?.threads?.fetchActive !== "function") return [];

  const active = await channel.threads.fetchActive().catch(() => null);
  for (const thread of active?.threads?.values?.() ?? []) found.set(thread.id, thread);

  let before;
  for (let page = 0; page < MAX_ARCHIVED_PAGES; page += 1) {
    if (typeof channel.threads.fetchArchived !== "function") break;

    const result = await channel.threads
      .fetchArchived({ limit: 100, type: "public", ...(before ? { before } : {}) })
      .catch(() => null);
    const batch = [...(result?.threads?.values?.() ?? [])];
    if (batch.length === 0) break;

    const seen = found.size;
    for (const thread of batch) found.set(thread.id, thread);
    if (!result.hasMore || found.size === seen) break;

    const last = batch[batch.length - 1];
    before = last.archivedTimestamp ? new Date(last.archivedTimestamp).toISOString() : undefined;
    if (!before) break;
  }

  return [...found.values()];
}

/**
 * Walk the bot's own messages in both servers and rewrite every embed that was
 * posted before the current style. A message is only touched when one of its
 * embeds is a known old kind, so other bots' embeds and mirrored messages from
 * people are left alone. Running it twice changes nothing the second time.
 */
export async function migrateEmbeds({
  guilds = [],
  botId = null,
  limit = DEFAULT_SCAN_LIMIT,
  dryRun = false,
  delayMs = 250,
  onProgress = () => {},
  sleep = wait,
} = {}) {
  const report = {
    guilds: [],
    channelsScanned: 0,
    threadsScanned: 0,
    messagesScanned: 0,
    embedsSeen: 0,
    alreadyCurrent: 0,
    converted: 0,
    unknown: 0,
    updated: 0,
    kinds: {},
    failed: [],
    dryRun,
  };

  const scanLimit = Math.min(Math.max(Number(limit) || DEFAULT_SCAN_LIMIT, 1), 500);
  const owned = (message) =>
    Boolean(message?.embeds?.length) && (botId ? message.author?.id === botId : Boolean(message.author?.bot));

  async function visit(channel, label) {
    const messages = await fetchMessages(channel, scanLimit);
    if (messages.length === 0) return;

    for (const message of messages) {
      if (!owned(message)) continue;

      report.messagesScanned += 1;
      report.embedsSeen += message.embeds.length;

      const result = restyleEmbeds(message.embeds);
      report.alreadyCurrent += result.current;
      report.unknown += result.unknown;
      if (!result.changed) continue;

      for (const kind of result.kinds) {
        report.kinds[kind] = (report.kinds[kind] ?? 0) + 1;
      }

      if (dryRun) {
        report.converted += result.converted;
        continue;
      }

      if (typeof message.edit !== "function") {
        report.failed.push(`${label}: a message in ${channel.name ?? channel.id} can't be edited`);
        continue;
      }

      try {
        await message.edit({ embeds: result.embeds });
        report.converted += result.converted;
        report.updated += 1;
        onProgress({ label, converted: report.converted });
        if (delayMs > 0) await sleep(delayMs);
      } catch (error) {
        report.failed.push(
          `${label} in ${channel.name ?? channel.id}: ${error?.message ?? error}`,
        );
      }
    }

    report.channelsScanned += 1;
  }

  for (const guild of guilds.filter(Boolean)) {
    report.guilds.push({ id: guild.id, name: guild.name ?? guild.id });

    // The cache normally holds every channel; fetch first when it doesn't.
    if (guild.channels?.cache?.size === 0 && typeof guild.channels?.fetch === "function") {
      await guild.channels.fetch().catch(() => null);
    }

    for (const channel of guild.channels?.cache?.values?.() ?? []) {
      if (!SCANNABLE_TYPES.has(channel?.type)) continue;

      try {
        if (isForum(channel)) {
          const threads = await forumThreads(channel);
          for (const thread of threads) {
            report.threadsScanned += 1;
            const wasArchived = Boolean(thread.archived);
            const label = `#${thread.name ?? thread.id}`;

            await visit(thread, label);

            // Reading an archived post unarchives it; put it back afterwards.
            if (wasArchived && typeof thread.setArchived === "function") {
              await thread.setArchived(true, "Embed migration").catch(() => {});
            }
          }
          continue;
        }

        await visit(channel, `#${channel.name ?? channel.id}`);
      } catch (error) {
        report.failed.push(`${channel.name ?? channel.id}: ${error?.message ?? error}`);
      }
    }
  }

  return report;
}
