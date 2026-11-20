import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { createLiveSync } from "../src/lib/live.js";
import { fakeGuild } from "./fixtures.js";

const SOURCE_ID = "1000";
const TARGET_ID = "2000";

function liveChannel(overrides = {}) {
  return {
    id: "s1",
    name: "general",
    type: ChannelType.GuildText,
    guildId: SOURCE_ID,
    parentId: null,
    position: 0,
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    defaultAutoArchiveDuration: null,
    defaultThreadRateLimitPerUser: null,
    permissionOverwrites: { cache: new Map() },
    ...overrides,
  };
}

function sourceWith({ channels = [], roles = [] } = {}) {
  const guild = {
    id: SOURCE_ID,
    name: "Main",
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    roles: { cache: new Map(roles.map((role) => [role.id, role])) },
  };
  for (const role of roles) role.guild = guild;
  return guild;
}

function liveRole(overrides = {}) {
  return {
    id: "r1",
    name: "Staff",
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: { bitfield: 8n },
    managed: false,
    unicodeEmoji: null,
    position: 1,
    guild: null,
    ...overrides,
  };
}

async function setup({ channels = [], roles = [] } = {}) {
  const target = fakeGuild({ id: TARGET_ID });
  const source = sourceWith({ channels, roles });
  const live = createLiveSync({ sourceId: SOURCE_ID, targetId: TARGET_ID, client: {} });
  await live.attach(source, target);
  return { live, source, target };
}

test("a new channel is created in the target with its settings", async () => {
  const { live, target } = await setup();

  await live.onChannelCreate(liveChannel({ id: "s1", name: "announcements", topic: "News" }));

  const created = target.createdChannels[0];
  assert.equal(created.name, "announcements");
  assert.equal(created.type, ChannelType.GuildText);
  assert.equal(created.topic, "News");
});

test("a new category is created before the channel inside it", async () => {
  const { live, target } = await setup();

  await live.onChannelCreate(
    liveChannel({ id: "s1", name: "Talk", type: ChannelType.GuildCategory }),
  );
  await live.onChannelCreate(liveChannel({ id: "s2", name: "general", parentId: "s1" }));

  const [category, channel] = target.createdChannels;
  assert.equal(category.name, "Talk");
  assert.equal(channel.parentId, category.id);
});

test("renaming and re-topic-ing a channel updates the target channel", async () => {
  const channel = liveChannel();
  const { live, target } = await setup({ channels: [channel] });
  await live.onChannelCreate(channel);

  const renamed = { ...channel, name: "lobby", topic: "Say hi" };
  await live.onChannelUpdate(channel, renamed);

  const created = target.createdChannels[0];
  assert.equal(created.name, "lobby");
  assert.equal(created.topic, "Say hi");
  assert.equal(target.createdChannels.length, 1, "no duplicate channel");
});

test("deleting a channel deletes the mirrored one", async () => {
  const channel = liveChannel();
  const { live, target } = await setup({ channels: [channel] });
  await live.onChannelCreate(channel);
  const created = target.createdChannels[0];

  await live.onChannelDelete(channel);

  assert.equal(created.deleted, true);
  assert.equal(target.channels.cache.has(created.id), false);
});

test("channel types that can't be cloned are ignored", async () => {
  const { live, target } = await setup();

  await live.onChannelCreate(
    liveChannel({ id: "s1", name: "Directory", type: ChannelType.GuildDirectory }),
  );

  assert.equal(target.createdChannels.length, 0);
});

test("roles are created, edited and deleted in the target", async () => {
  const role = liveRole();
  const { live, target } = await setup({ roles: [role] });

  await live.onRoleCreate(role);
  const created = target.createdRoles[0];
  assert.equal(created.name, "Staff");

  const edited = { ...role, name: "Moderator", color: 0x00ff00 };
  await live.onRoleUpdate(role, edited);
  assert.equal(created.name, "Moderator");
  assert.equal(created.color, 0x00ff00);

  await live.onRoleDelete(edited);
  assert.equal(created.deleted, true);
});

test("a role update for a role the target has never seen is created", async () => {
  const role = liveRole({ id: "r2", name: "Helpers" });
  const { live, target } = await setup({ roles: [role] });

  await live.onRoleUpdate(role, role);

  assert.equal(target.createdRoles.length, 1);
  assert.equal(target.createdRoles[0].name, "Helpers");
});

test("server settings follow the source", async () => {
  const { live, target } = await setup();
  const before = { id: SOURCE_ID, name: "Main", icon: null, afkChannelId: null, systemChannelId: null };
  const after = { ...before, name: "Main 2" };

  await live.onGuildUpdate(before, after);

  assert.equal(target.name, "Main 2 Preview");
});
