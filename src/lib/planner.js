import { MESSAGE_CHANNEL_TYPES } from "./snapshot.js";

const nameKey = (name) => name.trim().toLowerCase();

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function countBy(entries, action) {
  return entries.filter((entry) => entry.action === action).length;
}

/**
 * Work out what has to happen to turn `target` into a copy of `source`.
 * Pure: no Discord calls, no mutation of either snapshot.
 */
export function planReplication(source, target, options = {}) {
  const opts = {
    reuseRoles: options.reuseRoles ?? true,
    reuseChannels: options.reuseChannels ?? true,
    reuseEmojis: options.reuseEmojis ?? true,
    copySettings: options.copySettings ?? true,
    maxMessages: options.maxMessages ?? 0,
  };

  const warnings = [];
  const warn = (message) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  // ---------------------------------------------------------------- roles
  const targetRolesByName = groupBy(
    target.roles.filter((role) => !role.managed),
    (role) => nameKey(role.name),
  );

  const roles = [];
  for (const role of source.roles) {
    const entry = {
      sourceId: role.id,
      name: role.name,
      position: role.position,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions,
      unicodeEmoji: role.unicodeEmoji,
    };

    if (role.managed) {
      roles.push({ ...entry, action: "skip", reason: "owned by a bot or app integration" });
      continue;
    }

    const match =
      opts.reuseRoles && targetRolesByName.has(nameKey(role.name))
        ? targetRolesByName.get(nameKey(role.name)).shift()
        : undefined;

    roles.push(
      match
        ? { ...entry, action: "reuse", targetId: match.id }
        : { ...entry, action: "create", targetId: null },
    );
  }

  const copiedRoleIds = new Set(
    roles.filter((role) => role.action !== "skip").map((role) => role.sourceId),
  );

  // ------------------------------------------------------------- channels
  const targetCategoriesByName = groupBy(
    target.channels.filter((channel) => channel.type === "category"),
    (channel) => nameKey(channel.name),
  );
  const targetChannelsByTypeName = groupBy(
    target.channels.filter((channel) => channel.type !== "category"),
    (channel) => `${channel.type}:${nameKey(channel.name)}`,
  );

  const categories = [];
  for (const channel of source.channels.filter((entry) => entry.type === "category")) {
    const match =
      opts.reuseChannels && targetCategoriesByName.has(nameKey(channel.name))
        ? targetCategoriesByName.get(nameKey(channel.name)).shift()
        : undefined;

    categories.push({
      ...channel,
      sourceId: channel.id,
      action: match ? "reuse" : "create",
      targetId: match?.id ?? null,
    });
  }

  const categoryIds = new Set(categories.map((category) => category.sourceId));

  let droppedRoleOverwrites = 0;
  let memberOverwrites = 0;
  const channels = [];

  for (const channel of source.channels.filter((entry) => entry.type !== "category")) {
    const match =
      opts.reuseChannels && targetChannelsByTypeName.has(`${channel.type}:${nameKey(channel.name)}`)
        ? targetChannelsByTypeName.get(`${channel.type}:${nameKey(channel.name)}`).shift()
        : undefined;

    const overwrites = [];
    let dropped = 0;
    for (const overwrite of channel.overwrites) {
      if (
        overwrite.type === "role" &&
        overwrite.id !== source.id &&
        !copiedRoleIds.has(overwrite.id)
      ) {
        dropped += 1;
        continue;
      }
      if (overwrite.type === "member") memberOverwrites += 1;
      overwrites.push(overwrite);
    }
    droppedRoleOverwrites += dropped;

    channels.push({
      ...channel,
      sourceId: channel.id,
      parentSourceId: channel.parentId && categoryIds.has(channel.parentId) ? channel.parentId : null,
      action: match ? "reuse" : "create",
      targetId: match?.id ?? null,
      overwrites,
      droppedOverwrites: dropped,
      messages:
        opts.maxMessages > 0 && MESSAGE_CHANNEL_TYPES.has(channel.type) ? opts.maxMessages : 0,
    });
  }

  // --------------------------------------------------------------- emojis
  const targetEmojiNames = new Set(target.emojis.map((emoji) => emoji.name));
  const emojis = source.emojis.map((emoji) => {
    if (opts.reuseEmojis && targetEmojiNames.has(emoji.name)) {
      return { ...emoji, action: "skip", reason: "already exists in the target" };
    }
    return { ...emoji, action: "create" };
  });

  // ------------------------------------------------------------- settings
  const settings = [];
  if (opts.copySettings) {
    if (source.name !== target.name) {
      settings.push({ key: "name", label: "Server name", value: source.name, from: target.name });
    }

    if (source.iconHash && source.iconHash !== target.iconHash) {
      settings.push({ key: "icon", label: "Server icon", value: source.iconURL });
    }

    const channelName = (id) => source.channels.find((channel) => channel.id === id)?.name ?? null;

    if (source.settings.afkChannelId && channelName(source.settings.afkChannelId)) {
      settings.push({
        key: "afkChannel",
        label: "AFK channel",
        sourceChannelId: source.settings.afkChannelId,
        value: `#${channelName(source.settings.afkChannelId)}`,
      });
    }

    if (source.settings.afkTimeout !== null && source.settings.afkTimeout !== target.settings.afkTimeout) {
      settings.push({
        key: "afkTimeout",
        label: "AFK timeout",
        value: source.settings.afkTimeout,
        from: target.settings.afkTimeout,
      });
    }

    if (source.settings.systemChannelId && channelName(source.settings.systemChannelId)) {
      settings.push({
        key: "systemChannel",
        label: "System messages channel",
        sourceChannelId: source.settings.systemChannelId,
        value: `#${channelName(source.settings.systemChannelId)}`,
      });
    }

    if (
      source.settings.verificationLevel !== null &&
      source.settings.verificationLevel !== target.settings.verificationLevel
    ) {
      settings.push({
        key: "verificationLevel",
        label: "Verification level",
        value: source.settings.verificationLevel,
        from: target.settings.verificationLevel,
      });
    }

    if (
      source.settings.explicitContentFilter !== null &&
      source.settings.explicitContentFilter !== target.settings.explicitContentFilter
    ) {
      settings.push({
        key: "explicitContentFilter",
        label: "Explicit content filter",
        value: source.settings.explicitContentFilter,
        from: target.settings.explicitContentFilter,
      });
    }

    if (
      source.settings.defaultMessageNotifications !== null &&
      source.settings.defaultMessageNotifications !== target.settings.defaultMessageNotifications
    ) {
      settings.push({
        key: "defaultNotifications",
        label: "Default notifications",
        value: source.settings.defaultMessageNotifications,
        from: target.settings.defaultMessageNotifications,
      });
    }
  }

  // ------------------------------------------------------------- warnings
  const skippedRoles = roles.filter((role) => role.action === "skip");
  if (skippedRoles.length) {
    warn(
      `${skippedRoles.length} managed role(s) can't be copied: ${skippedRoles
        .map((role) => `“${role.name}”`)
        .join(", ")}. Channels will be created without their permissions.`,
    );
  }
  if (droppedRoleOverwrites) {
    warn(
      `${droppedRoleOverwrites} permission overwrite(s) point at roles that can't be copied and will be left out.`,
    );
  }
  if (memberOverwrites) {
    warn(
      "Member-specific permissions are copied only for members who are also in the target server.",
    );
  }
  if (opts.maxMessages > 0) {
    warn(
      `Up to ${opts.maxMessages} recent message(s) per text channel will be replayed through a webhook as the original authors.`,
    );
  }

  return {
    source: { id: source.id, name: source.name, memberCount: source.memberCount },
    target: { id: target.id, name: target.name, memberCount: target.memberCount },
    roles,
    categories,
    channels,
    emojis,
    settings,
    warnings,
    options: opts,
    stats: {
      roles: {
        create: countBy(roles, "create"),
        reuse: countBy(roles, "reuse"),
        skip: countBy(roles, "skip"),
      },
      categories: {
        create: countBy(categories, "create"),
        reuse: countBy(categories, "reuse"),
      },
      channels: {
        create: countBy(channels, "create"),
        reuse: countBy(channels, "reuse"),
      },
      emojis: {
        create: countBy(emojis, "create"),
        skip: countBy(emojis, "skip"),
      },
      settings: settings.length,
      messages: channels.reduce((total, channel) => total + channel.messages, 0),
    },
  };
}
