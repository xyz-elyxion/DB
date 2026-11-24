import { CLONEABLE_CHANNEL_TYPES, snapshotChannel } from "./snapshot.js";
import { buildOverwrites, channelCreatePayload, CHANNEL_SETTING_FIELDS } from "./builder.js";
import { describeError } from "./errors.js";
import { findMirrorChannel, MAX_EMBEDS, mirrorMessage, webhookPayload } from "./mirror.js";
import { splitContent } from "./messages.js";
import { previewName, readOnlyOverwrites } from "./preview.js";

const EMOJI_SLOTS = 50;
const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_TRACKED_MESSAGES = 5000;

/**
 * Keeps a target guild in step with a source guild, change by change.
 *
 * The startup sync converges everything that already exists; after `attach()`
 * every event the bot receives is replayed into the target: channels and
 * categories (create, rename, settings, permissions, order, delete), roles
 * (create, edit, order, delete), emojis, guild settings, and messages
 * (post, edit, delete).
 */
export function createLiveSync({
  sourceId,
  targetId,
  client,
  reason = "Mirroring changes",
  readOnly = true,
}) {
  let source = null;
  let target = null;

  const channelMap = new Map(); // source channel id -> target channel
  const roleMap = new Map(); // source role id -> target role
  const memberCache = new Map();
  const hooks = new Map(); // target channel id -> webhook
  const messages = new Map(); // source message id -> { webhook, ids }
  const report = { warnings: [] };

  const log = (text) => console.log(`[live] ${text}`);
  const warn = (text) => console.warn(`[live] ${text}`);

  function remember(sourceMessageId, entry) {
    messages.set(sourceMessageId, entry);
    if (messages.size > MAX_TRACKED_MESSAGES) {
      messages.delete(messages.keys().next().value);
    }
  }

  function targetChannelFor(channel) {
    const known = channelMap.get(channel.id);
    if (known) return known;

    const found = findMirrorChannel(channel, target);
    if (found) channelMap.set(channel.id, found);
    return found ?? null;
  }

  function targetRoleFor(role) {
    const known = roleMap.get(role.id);
    if (known) return known;

    const found =
      [...target.roles.cache.values()].find(
        (candidate) => !candidate.managed && candidate.name === role.name,
      ) ?? null;
    if (found) roleMap.set(role.id, found);
    return found;
  }

  async function createChannel(channel) {
    const type = CLONEABLE_CHANNEL_TYPES.get(channel.type);
    if (!type) return null;

    const entry = snapshotChannel(channel, type);
    const parent = entry.parentId ? channelMap.get(entry.parentId) ?? null : null;
    const overwrites = await buildOverwrites(entry, roleMap, target, memberCache, report);
    const finalOverwrites = readOnly ? readOnlyOverwrites(overwrites, target.id) : overwrites;

    const created = await target.channels.create({
      ...channelCreatePayload(entry, parent, finalOverwrites),
      reason,
    });
    channelMap.set(channel.id, created);
    log(`created #${channel.name}`);
    return created;
  }

  async function createRole(role) {
    const created = await target.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield,
      unicodeEmoji: role.unicodeEmoji ?? undefined,
      reason,
    });
    roleMap.set(role.id, created);
    log(`created role “${role.name}”`);
    return created;
  }

  async function copyEmoji(emoji) {
    const used = target.emojis?.cache?.size ?? 0;
    if (used >= EMOJI_SLOTS) {
      warn("no emoji slots left in the target server");
      return;
    }
    if ([...(target.emojis?.cache?.values() ?? [])].some((one) => one.name === emoji.name)) return;

    const url = emoji.imageURL({ extension: emoji.animated ? "gif" : "png", size: 128 });
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) {
      warn(`couldn't download emoji :${emoji.name}:`);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_EMOJI_BYTES) {
      warn(`emoji :${emoji.name}: is larger than 256 KB`);
      return;
    }

    await target.emojis.create({ attachment: buffer, name: emoji.name, reason });
    log(`created emoji :${emoji.name}:`);
  }

  async function mirrorOneMessage(message) {
    if (message.guildId !== sourceId) return;

    const result = await mirrorMessage({ message, targetGuild: target, client, hooks });
    if (result.reason === "no matching channel") {
      warn(`no target channel for #${message.channel?.name}, so that message was skipped`);
      return;
    }
    if (!result.mirrored) return;

    remember(message.id, { webhook: result.webhook, ids: result.messageIds });
  }

  return {
    /** Match the channels and roles that already exist, so later changes update them. */
    async attach(sourceGuild, targetGuild) {
      source = sourceGuild;
      target = targetGuild;

      for (const channel of source.channels.cache.values()) {
        if (!CLONEABLE_CHANNEL_TYPES.has(channel.type)) continue;
        const found = findMirrorChannel(channel, target);
        if (found) channelMap.set(channel.id, found);
      }

      roleMap.set(source.id, { id: target.id });
      for (const role of source.roles.cache.values()) {
        if (role.id === source.id || role.managed) continue;
        const found =
          [...target.roles.cache.values()].find(
            (candidate) => !candidate.managed && candidate.name === role.name,
          ) ?? null;
        if (found) roleMap.set(role.id, found);
      }
    },

    async onChannelCreate(channel) {
      if (channel.guildId !== sourceId) return;
      if (!CLONEABLE_CHANNEL_TYPES.has(channel.type)) return;
      if (channelMap.has(channel.id)) return;
      await createChannel(channel);
    },

    async onChannelUpdate(_oldChannel, newChannel) {
      if (newChannel.guildId !== sourceId) return;
      const type = CLONEABLE_CHANNEL_TYPES.get(newChannel.type);
      if (!type) return;

      let targetChannel = targetChannelFor(newChannel);
      if (!targetChannel) {
        await createChannel(newChannel);
        return;
      }

      const entry = snapshotChannel(newChannel, type);
      const edits = { reason };

      if (targetChannel.name !== newChannel.name) edits.name = newChannel.name;
      for (const field of CHANNEL_SETTING_FIELDS) {
        if (entry[field] === undefined || entry[field] === null) continue;
        if (targetChannel[field] !== entry[field]) edits[field] = entry[field];
      }

      const parent = entry.parentId ? channelMap.get(entry.parentId) ?? null : null;
      if ((targetChannel.parentId ?? null) !== (parent?.id ?? null)) {
        edits.parent = parent?.id ?? null;
      }

      if (Object.keys(edits).length > 1) await targetChannel.edit(edits);
      if (typeof targetChannel.permissionOverwrites?.set === "function") {
        const overwrites = await buildOverwrites(entry, roleMap, target, memberCache, report);
        await targetChannel.permissionOverwrites.set(
          readOnly ? readOnlyOverwrites(overwrites, target.id) : overwrites,
          reason,
        );
      }

      if (
        typeof targetChannel.setPosition === "function" &&
        targetChannel.position !== entry.position
      ) {
        await targetChannel
          .setPosition(entry.position)
          .catch((error) => warn(`couldn't move #${newChannel.name}: ${describeError(error)}`));
      }

      log(`updated #${newChannel.name}`);
    },

    async onChannelDelete(channel) {
      if (channel.guildId !== sourceId) return;

      const targetChannel = targetChannelFor(channel);
      if (!targetChannel) return;

      channelMap.delete(channel.id);
      for (const [sourceChildId, targetChild] of channelMap) {
        if (targetChild.parentId === targetChannel.id) channelMap.delete(sourceChildId);
      }

      await targetChannel.delete(reason);
      log(`deleted #${channel.name}`);
    },

    async onRoleCreate(role) {
      if (role.guild?.id !== sourceId) return;
      if (role.id === sourceId || role.managed) return;
      if (roleMap.has(role.id)) return;
      await createRole(role);
    },

    async onRoleUpdate(oldRole, newRole) {
      if (newRole.guild?.id !== sourceId) return;
      if (newRole.id === sourceId || newRole.managed) return;

      let mapped = targetRoleFor(newRole);
      if (!mapped) {
        await createRole(newRole);
        return;
      }

      const edits = { reason };
      if (mapped.name !== newRole.name) edits.name = newRole.name;
      if ((mapped.color ?? 0) !== newRole.color) edits.color = newRole.color;
      if (Boolean(mapped.hoist) !== newRole.hoist) edits.hoist = newRole.hoist;
      if (Boolean(mapped.mentionable) !== newRole.mentionable) {
        edits.mentionable = newRole.mentionable;
      }
      const permissions = newRole.permissions.bitfield ?? newRole.permissions;
      if (String(mapped.permissions?.bitfield ?? mapped.permissions) !== String(permissions)) {
        edits.permissions = permissions;
      }

      if (Object.keys(edits).length > 1) await mapped.edit(edits);
      if (oldRole?.position !== undefined && oldRole.position !== newRole.position) {
        await mapped
          .setPosition(newRole.position)
          .catch((error) => warn(`couldn't move role “${newRole.name}”: ${describeError(error)}`));
      }

      log(`updated role “${newRole.name}”`);
    },

    async onRoleDelete(role) {
      if (role.guild?.id !== sourceId) return;
      if (role.id === sourceId || role.managed) return;

      const mapped = roleMap.get(role.id);
      roleMap.delete(role.id);
      if (!mapped) return;

      await mapped.delete(reason);
      log(`deleted role “${role.name}”`);
    },

    async onEmojiCreate(emoji) {
      if (emoji.guild?.id !== sourceId) return;
      await copyEmoji(emoji);
    },

    async onEmojiUpdate(oldEmoji, newEmoji) {
      if (newEmoji.guild?.id !== sourceId) return;
      const existing = [...(target.emojis?.cache?.values() ?? [])].find(
        (emoji) => emoji.name === oldEmoji?.name,
      );
      if (existing && oldEmoji?.name !== newEmoji.name) {
        await existing.setName(newEmoji.name, reason);
        log(`renamed emoji :${oldEmoji.name}: to :${newEmoji.name}:`);
      }
    },

    async onEmojiDelete(emoji) {
      if (emoji.guild?.id !== sourceId) return;
      const existing = [...(target.emojis?.cache?.values() ?? [])].find(
        (candidate) => candidate.name === emoji.name,
      );
      if (!existing) return;
      await existing.delete(reason);
      log(`deleted emoji :${emoji.name}:`);
    },

    async onGuildUpdate(oldGuild, newGuild) {
      if (newGuild.id !== sourceId) return;

      const wantedName = previewName(newGuild.name);
      if (wantedName !== target.name && typeof target.setName === "function") {
        await target.setName(wantedName, reason);
      }
      if ((newGuild.icon ?? null) !== (target.icon ?? null) && typeof target.setIcon === "function") {
        await target.setIcon(newGuild.iconURL({ extension: "png", size: 256 }), reason);
      }

      const afk = newGuild.afkChannelId ? channelMap.get(newGuild.afkChannelId) ?? null : null;
      if (afk && newGuild.afkChannelId !== target.afkChannelId) {
        await target.setAFKChannel?.(afk, reason);
      }
      if (newGuild.afkTimeout !== target.afkTimeout) {
        await target.setAFKTimeout?.(newGuild.afkTimeout, reason);
      }

      const system = newGuild.systemChannelId
        ? channelMap.get(newGuild.systemChannelId) ?? null
        : null;
      if (system && newGuild.systemChannelId !== target.systemChannelId) {
        await target.setSystemChannel?.(system, reason);
      }
      if (newGuild.verificationLevel !== target.verificationLevel) {
        await target.setVerificationLevel?.(newGuild.verificationLevel, reason);
      }
      if (newGuild.explicitContentFilter !== target.explicitContentFilter) {
        await target.setExplicitContentFilter?.(newGuild.explicitContentFilter, reason);
      }
      if (newGuild.defaultMessageNotifications !== target.defaultMessageNotifications) {
        await target.setDefaultMessageNotifications?.(newGuild.defaultMessageNotifications, reason);
      }

      log("updated server settings");
    },

    onMessageCreate: mirrorOneMessage,

    async onMessageUpdate(oldMessage, newMessage) {
      if (newMessage.guildId !== sourceId) return;

      const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
      if (!message) return;

      const tracked = messages.get(message.id);
      if (!tracked) {
        await mirrorOneMessage(message);
        return;
      }

      const chunks = splitContent(message.content);
      if (chunks.length === 0) chunks.push("");
      for (const [index, chunk] of chunks.entries()) {
        const embeds = index === 0 ? [...(message.embeds ?? [])].slice(0, MAX_EMBEDS) : [];
        if (tracked.ids[index]) {
          await tracked.webhook
            .editMessage(tracked.ids[index], {
              content: chunk,
              embeds,
              allowedMentions: { parse: [] },
            })
            .catch((error) => warn(`couldn't edit a mirrored message: ${describeError(error)}`));
          continue;
        }
        const sent = await tracked.webhook.send(webhookPayload(message, chunk, index === 0));
        if (sent?.id) tracked.ids.push(sent.id);
      }

      for (const extra of tracked.ids.splice(chunks.length)) {
        await tracked.webhook.deleteMessage(extra).catch(() => {});
      }

      log(`edited a message in #${message.channel?.name}`);
    },

    async onMessageDelete(message) {
      if (message.guildId !== sourceId) return;

      const tracked = messages.get(message.id);
      if (!tracked) return;
      messages.delete(message.id);

      for (const id of tracked.ids) {
        await tracked.webhook.deleteMessage(id).catch(() => {});
      }

      log(`deleted a message in #${message.channel?.name}`);
    },
  };
}
