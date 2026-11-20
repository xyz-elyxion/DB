import { ChannelType, OverwriteType } from "discord.js";

export const EMPTY_SETTINGS = {
  afkChannelId: null,
  afkTimeout: null,
  systemChannelId: null,
  verificationLevel: null,
  explicitContentFilter: null,
  defaultMessageNotifications: null,
};

export function makeSnapshot(overrides = {}) {
  return {
    id: "1000",
    name: "Source",
    memberCount: 12,
    iconHash: null,
    iconURL: null,
    roles: [],
    channels: [],
    emojis: [],
    settings: { ...EMPTY_SETTINGS },
    ...overrides,
    settings: { ...EMPTY_SETTINGS, ...(overrides.settings ?? {}) },
  };
}

export function makeRole(overrides = {}) {
  return {
    id: "r1",
    name: "Staff",
    position: 1,
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: "8",
    managed: false,
    unicodeEmoji: null,
    ...overrides,
  };
}

export function makeChannel(overrides = {}) {
  return {
    id: "c1",
    name: "general",
    type: "text",
    parentId: null,
    position: 0,
    overwrites: [],
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    defaultAutoArchiveDuration: null,
    defaultThreadRateLimitPerUser: null,
    ...overrides,
  };
}

/**
 * Just enough of a discord.js Guild for the executor: collections, create()
 * methods, edits and positions. Records everything it is asked to do.
 */
export function fakeGuild({ id = "2000", name = "Preview", roles = [], channels = [] } = {}) {
  let sequence = 0;

  const guild = {
    id,
    name,
    roles: { cache: new Map() },
    channels: { cache: new Map() },
    members: { cache: new Map() },
    emojis: { cache: new Map(), created: [] },
    createdRoles: [],
    createdChannels: [],
    edits: [],
  };

  for (const role of roles) guild.roles.cache.set(role.id, role);
  for (const channel of channels) guild.channels.cache.set(channel.id, channel);

  guild.roles.create = async (payload) => {
    const role = {
      id: `role-${++sequence}`,
      name: payload.name,
      color: payload.color ?? 0,
      hoist: Boolean(payload.hoist),
      mentionable: Boolean(payload.mentionable),
      permissions: { bitfield: payload.permissions ?? 0n },
      position: 1,
      managed: false,
      edits: [],
      async edit(changes) {
        Object.assign(role, changes);
        role.edits.push(changes);
      },
      async setPosition(position) {
        role.position = position;
      },
    };
    guild.roles.cache.set(role.id, role);
    guild.createdRoles.push(role);
    return role;
  };

  guild.channels.create = async (payload) => {
    const channel = {
      id: `channel-${++sequence}`,
      name: payload.name,
      type: payload.type,
      parentId: payload.parent ?? null,
      position: payload.position ?? 0,
      topic: payload.topic ?? null,
      nsfw: payload.nsfw ?? false,
      rateLimitPerUser: payload.rateLimitPerUser ?? 0,
      bitrate: payload.bitrate ?? null,
      userLimit: payload.userLimit ?? 0,
      permissionOverwrites: {
        cache: new Map(),
        async set(overwrites) {
          channel.appliedOverwrites = overwrites;
        },
      },
      payload,
      async edit(changes) {
        Object.assign(channel, changes);
      },
      async setPosition(position) {
        channel.position = position;
      },
    };
    guild.channels.cache.set(channel.id, channel);
    guild.createdChannels.push(channel);
    return channel;
  };

  guild.roles.fetch = async (roleId) => guild.roles.cache.get(roleId) ?? null;
  guild.channels.fetch = async (channelId) => guild.channels.cache.get(channelId) ?? null;
  guild.members.fetch = async (memberId) => guild.members.cache.get(memberId) ?? null;

  guild.setName = async (value) => {
    guild.name = value;
    guild.edits.push({ key: "name", value });
  };

  return guild;
}

/** Fake discord.js guild used to exercise the snapshot reader. */
export function fakeSourceGuild() {
  const everyone = {
    id: "1000",
    name: "@everyone",
    position: 0,
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: { bitfield: 104324673n },
    managed: false,
    unicodeEmoji: null,
  };

  return {
    id: "1000",
    name: "Source",
    icon: null,
    memberCount: 42,
    iconURL: () => null,
    afkChannelId: null,
    afkTimeout: 300,
    systemChannelId: null,
    verificationLevel: 1,
    explicitContentFilter: 0,
    defaultMessageNotifications: 0,
    roles: {
      cache: new Map([
        ["1000", everyone],
        [
          "1001",
          {
            id: "1001",
            name: "Moderator",
            position: 4,
            color: 0x00ff00,
            hoist: true,
            mentionable: false,
            permissions: { bitfield: 8n },
            managed: false,
            unicodeEmoji: null,
          },
        ],
        [
          "1002",
          {
            id: "1002",
            name: "SomeBot",
            position: 2,
            color: 0,
            hoist: false,
            mentionable: false,
            permissions: { bitfield: 0n },
            managed: true,
            unicodeEmoji: null,
          },
        ],
      ]),
    },
    channels: {
      cache: new Map([
        [
          "2001",
          {
            id: "2001",
            name: "Rules",
            type: ChannelType.GuildCategory,
            position: 0,
            parentId: null,
            permissionOverwrites: { cache: new Map() },
          },
        ],
        [
          "2002",
          {
            id: "2002",
            name: "welcome",
            type: ChannelType.GuildText,
            position: 0,
            parentId: "2001",
            topic: "Be nice",
            nsfw: false,
            rateLimitPerUser: 5,
            defaultAutoArchiveDuration: 1440,
            defaultThreadRateLimitPerUser: 0,
            permissionOverwrites: {
              cache: new Map([
                [
                  "1001",
                  {
                    type: OverwriteType.Role,
                    id: "1001",
                    allow: { bitfield: 1024n },
                    deny: { bitfield: 0n },
                  },
                ],
              ]),
            },
          },
        ],
        [
          "2003",
          {
            id: "2003",
            name: "Lounge",
            type: ChannelType.GuildVoice,
            position: 1,
            parentId: null,
            bitrate: 64000,
            userLimit: 5,
            rtcRegion: null,
            videoQualityMode: null,
            permissionOverwrites: { cache: new Map() },
          },
        ],
        [
          "2004",
          {
            id: "2004",
            name: "Directory",
            type: ChannelType.GuildDirectory,
            position: 2,
            parentId: null,
            permissionOverwrites: { cache: new Map() },
          },
        ],
      ]),
    },
    emojis: {
      cache: new Map([
        ["3001", { id: "3001", name: "party", animated: false, imageURL: () => "https://cdn.example/party.png" }],
      ]),
    },
  };
}
