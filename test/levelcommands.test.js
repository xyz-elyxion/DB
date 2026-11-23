import test from "node:test";
import assert from "node:assert/strict";
import { createCaseStore } from "../src/lib/cases.js";
import { createLevelStore, totalXpForLevel } from "../src/lib/levels.js";
import { LEVEL_COMMANDS, runLevelCommand } from "../src/lib/levelcommands.js";

function guild() {
  return {
    id: "g1",
    name: "Main",
    channels: { cache: new Map(), async fetch() { return null; } },
  };
}

function moderator({ can = true } = {}) {
  return { id: "mod", user: { id: "mod", tag: "mod#0001" }, permissions: { has: () => can } };
}

function member(id) {
  return { id, tag: `${id}#0001` };
}

function interactionFor({ commandName, options = {}, can = true, guild: target = guild() }) {
  const replies = [];
  return {
    commandName,
    guild: target,
    guildId: target?.id ?? null,
    member: moderator({ can }),
    channel: null,
    options: {
      getUser: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

function levels() {
  return createLevelStore({ guildId: "g1" });
}

test("there is a command for every level feature", () => {
  const names = LEVEL_COMMANDS.map((command) => command.name).sort();
  assert.deepEqual(names, [
    "leaderboard",
    "level-announce",
    "level-rewards",
    "level-role",
    "level-settings",
    "level-toggle",
    "level-xp",
    "no-xp-channel",
    "rank",
    "reset-xp",
    "set-level",
  ]);
});

test("/rank shows level, XP, messages and rank", async () => {
  const store = levels();
  store.addXp({ guildId: "g1", userId: "u1", amount: 1000 });
  store.addXp({ guildId: "g1", userId: "u2", amount: 2000 });

  const interaction = interactionFor({ commandName: "rank", options: { member: member("u1") } });
  assert.equal(await runLevelCommand(interaction, { levels: store }), true);

  const [reply] = interaction.replies;
  assert.equal(reply.flags, 64, "private by default");
  const embed = reply.embeds[0].toJSON();
  assert.equal(embed.title, "Level 3");
  assert.match(embed.fields.find((field) => field.name === "Rank").value, /#2 of 2/);
  assert.match(embed.fields.at(-1).value, /XP/);
});

test("/rank public shows the card to the channel", async () => {
  const interaction = interactionFor({
    commandName: "rank",
    options: { member: member("u1"), public: true },
  });
  await runLevelCommand(interaction, { levels: levels() });

  assert.equal(interaction.replies[0].flags, undefined);
});

test("/leaderboard lists the top members, with pages", async () => {
  const store = levels();
  store.addXp({ guildId: "g1", userId: "u1", amount: 500 });
  store.addXp({ guildId: "g1", userId: "u2", amount: 1500 });

  const interaction = interactionFor({ commandName: "leaderboard", options: { page: 1 } });
  await runLevelCommand(interaction, { levels: store });

  const embed = interaction.replies[0].embeds[0].toJSON();
  assert.match(embed.description, /<@u2>/);
  assert.match(embed.title, /page 1\/1/);

  const empty = interactionFor({ commandName: "leaderboard" });
  await runLevelCommand(empty, { levels: levels() });
  assert.match(empty.replies[0].content, /Nobody has earned XP yet/);
});

test("management commands need Manage Server", async () => {
  const interaction = interactionFor({
    commandName: "level-xp",
    can: false,
    options: { member: member("u1"), amount: 100 },
  });

  await runLevelCommand(interaction, { levels: levels() });
  assert.match(interaction.replies[0].content, /Manage Server/);
});

test("/level-xp grants XP, reports the level and logs a case", async () => {
  const store = levels();
  const cases = createCaseStore();
  const synced = [];

  const interaction = interactionFor({
    commandName: "level-xp",
    options: { member: member("u1"), amount: 1000 },
  });

  await runLevelCommand(interaction, {
    levels: store,
    cases,
    syncRewards: (targetGuild, userId, level) => synced.push({ guild: targetGuild.id, userId, level }),
  });

  assert.equal(store.get("g1", "u1").xp, 1000);
  assert.match(interaction.replies[0].content, /level/);
  assert.equal(synced.length, 1, "role rewards are handed out on a level change");
  assert.equal(cases.forUser("g1", "u1", "level-xp").length, 1);
});

test("/set-level places someone exactly, and /reset-xp clears them", async () => {
  const store = levels();

  const setInteraction = interactionFor({
    commandName: "set-level",
    options: { member: member("u1"), level: 5 },
  });
  await runLevelCommand(setInteraction, { levels: store });
  assert.equal(store.get("g1", "u1").level, 5);
  assert.equal(store.get("g1", "u1").xp, totalXpForLevel(5));

  const resetInteraction = interactionFor({
    commandName: "reset-xp",
    options: { member: member("u1") },
  });
  await runLevelCommand(resetInteraction, { levels: store });
  assert.equal(store.get("g1", "u1").xp, 0);

  const again = interactionFor({ commandName: "reset-xp", options: { member: member("u1") } });
  await runLevelCommand(again, { levels: store });
  assert.match(again.replies[0].content, /no XP to reset/);
});

test("/level-role adds and removes role rewards", async () => {
  const store = levels();
  const role = { id: "role-a", name: "Active" };

  const add = interactionFor({
    commandName: "level-role",
    options: { level: 5, role },
  });
  await runLevelCommand(add, { levels: store });
  assert.deepEqual(store.rolesFor("g1", 5), ["role-a"]);
  assert.match(add.replies[0].content, /Reaching \*\*level 5\*\*/);

  const list = interactionFor({ commandName: "level-rewards" });
  await runLevelCommand(list, { levels: store });
  assert.match(list.replies[0].content, /Level 5/);

  const remove = interactionFor({ commandName: "level-role", options: { level: 5 } });
  await runLevelCommand(remove, { levels: store });
  assert.deepEqual(store.rolesFor("g1", 5), []);

  const missing = interactionFor({ commandName: "level-role", options: { level: 9 } });
  await runLevelCommand(missing, { levels: store });
  assert.match(missing.replies[0].content, /No role is unlocked at level 9/);
});

test("/no-xp-channel and /level-announce change the settings", async () => {
  const store = levels();
  const channel = { id: "c-quiet", name: "quiet" };

  const noXp = interactionFor({ commandName: "no-xp-channel", options: { channel } });
  await runLevelCommand(noXp, { levels: store });
  assert.deepEqual(store.settings("g1").noXpChannels, ["c-quiet"]);
  assert.match(noXp.replies[0].content, /no longer gives XP/);

  await runLevelCommand(
    interactionFor({ commandName: "no-xp-channel", options: { channel } }),
    { levels: store },
  );
  assert.deepEqual(store.settings("g1").noXpChannels, []);

  const announce = interactionFor({ commandName: "level-announce", options: { channel } });
  await runLevelCommand(announce, { levels: store });
  assert.equal(store.settings("g1").announceChannelId, "c-quiet");

  const off = interactionFor({ commandName: "level-announce", options: {} });
  await runLevelCommand(off, { levels: store });
  assert.equal(store.settings("g1").announceChannelId, null);
  assert.match(off.replies[0].content, /no longer be posted/);
});

test("/level-toggle flips levelling and /level-settings describes it", async () => {
  const store = levels();
  store.setRoleReward("g1", 3, "role-a");
  store.toggleNoXpChannel("g1", "c-quiet");

  const toggle = interactionFor({ commandName: "level-toggle", options: {} });
  await runLevelCommand(toggle, { levels: store });
  assert.equal(store.settings("g1").enabled, false);
  assert.match(toggle.replies[0].content, /Levelling is off/);

  const explicit = interactionFor({ commandName: "level-toggle", options: { enabled: true } });
  await runLevelCommand(explicit, { levels: store });
  assert.equal(store.settings("g1").enabled, true);

  const settings = interactionFor({ commandName: "level-settings" });
  await runLevelCommand(settings, { levels: store });
  const embed = settings.replies[0].embeds[0].toJSON();
  const values = embed.fields.map((field) => field.value).join("\n");
  assert.match(values, /On/);
  assert.match(values, /<#c-quiet>/);
  assert.match(values, /<@&role-a>/);
  assert.match(values, /15–25 XP/);
});

test("commands that are not level commands are left for the moderation handler", async () => {
  const interaction = interactionFor({ commandName: "ban" });
  assert.equal(await runLevelCommand(interaction, { levels: levels() }), false);
  assert.equal(interaction.replies.length, 0);
});
