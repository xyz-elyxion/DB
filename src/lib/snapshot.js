import { ChannelType, OverwriteType } from "discord.js";

/** Channel types this bot knows how to recreate. */
export const CLONEABLE_CHANNEL_TYPES = new Map([
  [ChannelType.GuildText, "text"],
  [ChannelType.GuildVoice, "voice"],
  [ChannelType.GuildCategory, "category"],
  [ChannelType.GuildAnnouncement, "announcement"],
  [ChannelType.GuildStageVoice, "stage"],
  [ChannelType.GuildForum, "forum"],
  [ChannelType.GuildMedia, "media"],
]);

/** "text" -> ChannelType.GuildText */
export const CHANNEL_TYPE_IDS = new Map(
  [...CLONEABLE_CHANNEL_TYPES].map(([type, name]) => [name, type]),
);

/** Channel types that can hold messages worth copying. */
export const MESSAGE_CHANNEL_TYPES = new Set(["text", "announcement"]);

export const CHANNEL_TYPE_LABELS = {
  text: "text",
  voice: "voice",
  category: "category",
  announcement: "announcement",
  stage: "stage",
  forum: "forum",
  media: "media",
};

function serialiseOverwrites(channel) {
  if (!channel.permissionOverwrites?.cache) return [];
  return [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    type: overwrite.type === OverwriteType.Member ? "member" : "role",
    id: overwrite.id,
    allow: String(overwrite.allow?.bitfield ?? overwrite.allow ?? 0n),
    deny: String(overwrite.deny?.bitfield ?? overwrite.deny ?? 0n),
  }));
}

function threadSettings(channel) {
  return {
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
    defaultThreadRateLimitPerUser: channel.defaultThreadRateLimitPerUser ?? null,
  };
}

export function snapshotChannel(channel, type) {
  const base = {
    id: channel.id,
    name: channel.name,
    type,
    parentId: channel.parentId ?? null,
    position: channel.position ?? 0,
    overwrites: serialiseOverwrites(channel),
  };

  if (type === "text" || type === "announcement") {
    return {
      ...base,
      topic: channel.topic ?? null,
      nsfw: Boolean(channel.nsfw),
      rateLimitPerUser: channel.rateLimitPerUser ?? 0,
      ...threadSettings(channel),
    };
  }

  if (type === "voice" || type === "stage") {
    return {
      ...base,
      bitrate: channel.bitrate ?? null,
      userLimit: channel.userLimit ?? 0,
      rtcRegion: channel.rtcRegion ?? null,
      videoQualityMode: channel.videoQualityMode ?? null,
    };
  }

  if (type === "forum" || type === "media") {
    return {
      ...base,
      topic: channel.topic ?? null,
      nsfw: Boolean(channel.nsfw),
      rateLimitPerUser: channel.rateLimitPerUser ?? 0,
      defaultSortOrder: channel.defaultSortOrder ?? null,
      defaultForumLayout: channel.defaultForumLayout ?? null,
      ...threadSettings(channel),
      availableTags: (channel.availableTags ?? []).map((tag) => ({
        name: tag.name,
        moderated: Boolean(tag.moderated),
        emojiName: tag.emoji?.name ?? null,
      })),
      defaultReactionEmoji: channel.defaultReactionEmoji
        ? { emojiName: channel.defaultReactionEmoji.name ?? null }
        : null,
    };
  }

  return base;
}

/**
 * Read a live discord.js Guild into a plain, serialisable description.
 * Everything downstream (planning, rendering, tests) works on this object
 * instead of on discord.js structures.
 */
export function snapshotGuild(guild) {
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
    .map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position ?? 0,
      color: typeof role.color === "number" ? role.color : 0,
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      permissions: String(role.permissions?.bitfield ?? 0n),
      managed: Boolean(role.managed),
      unicodeEmoji: role.unicodeEmoji ?? null,
    }));

  const channels = [...guild.channels.cache.values()]
    .map((channel) => ({ channel, type: CLONEABLE_CHANNEL_TYPES.get(channel.type) }))
    .filter((entry) => entry.type !== undefined)
    .sort((a, b) => (a.channel.position ?? 0) - (b.channel.position ?? 0) || a.channel.name.localeCompare(b.channel.name))
    .map((entry) => snapshotChannel(entry.channel, entry.type));

  const emojis = [...guild.emojis.cache.values()].map((emoji) => ({
    id: emoji.id,
    name: emoji.name,
    animated: Boolean(emoji.animated),
    url: emoji.imageURL({ extension: emoji.animated ? "gif" : "png", size: 128 }),
  }));

  return {
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount ?? null,
    iconHash: guild.icon ?? null,
    iconURL: guild.iconURL?.({ extension: "png", size: 256 }) ?? null,
    roles,
    channels,
    emojis,
    settings: {
      afkChannelId: guild.afkChannelId ?? null,
      afkTimeout: guild.afkTimeout ?? null,
      systemChannelId: guild.systemChannelId ?? null,
      verificationLevel: guild.verificationLevel ?? null,
      explicitContentFilter: guild.explicitContentFilter ?? null,
      defaultMessageNotifications: guild.defaultMessageNotifications ?? null,
    },
  };
}
