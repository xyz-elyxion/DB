import test from "node:test";
import assert from "node:assert/strict";
import { REP_COMMANDS, runRepCommand } from "../src/lib/repcommands.js";
import { createReputationStore } from "../src/lib/reputation.js";

function guild() {
  return { id: "g1", name: "Main" };
}

function interactionFor({
  commandName,
  options = {},
  can = true,
  user = { id: "mod" },
  target = guild(),
} = {}) {
  const replies = [];
  return {
    commandName,
    guild: target,
    guildId: target?.id ?? null,
    user,
    member: { id: "mod", permissions: { has: () => can } },
    options: {
      getUser: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

function reputation() {
  return createReputationStore({ guildId: "g1", now: () => 1_000_000 });
}

test("there is a command to give, read, rank and reset reputation", () => {
  assert.deepEqual(
    REP_COMMANDS.map((command) => command.name).sort(),
    ["rep", "rep-info", "rep-leaderboard", "rep-reset"],
  );
});

test("every command has a valid payload Discord accepts", () => {
  for (const command of REP_COMMANDS) {
    const json = command.toJSON();
    assert.ok(json.name.length > 0);
    assert.ok(json.description.length > 0);
    for (const option of json.options ?? []) {
      assert.ok(option.name && option.description, `${json.name}: ${option.name}`);
    }
  }
});

test("/rep gives a point and is private by default", async () => {
  const store = reputation();
  const interaction = interactionFor({
    commandName: "rep",
    options: { member: { id: "u2" }, note: "helped with homework" },
  });

  assert.equal(await runRepCommand(interaction, { reputation: store }), true);

  assert.equal(store.score("g1", "u2"), 1);
  assert.match(interaction.replies[0].content, /\+1/);
  assert.match(interaction.replies[0].content, /helped with homework/);
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("/rep refuses a member who tries to rep themselves", async () => {
  const store = reputation();
  const interaction = interactionFor({
    commandName: "rep",
    options: { member: { id: "mod" } },
  });

  await runRepCommand(interaction, { reputation: store });
  assert.match(interaction.replies[0].content, /can't give reputation to yourself/);
  assert.equal(store.score("g1", "mod"), 0);
});

test("/rep-info shows the score, rank and recent reasons", async () => {
  const store = reputation();
  store.give({ guildId: "g1", userId: "u2", fromId: "u1", note: "great" });
  store.give({ guildId: "g1", userId: "u2", fromId: "u3", note: "helpful" });

  const interaction = interactionFor({
    commandName: "rep-info",
    options: { member: { id: "u2" } },
  });
  await runRepCommand(interaction, { reputation: store });

  const embed = interaction.replies[0].embeds[0].toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Points, "2");
  assert.equal(fields.Rank, "#1 of 1");
  assert.match(embed.description, /great/);
  assert.match(embed.description, /helpful/);
});

test("/rep-leaderboard handles an empty board and a full one", async () => {
  const store = reputation();
  const empty = interactionFor({ commandName: "rep-leaderboard", options: {} });
  await runRepCommand(empty, { reputation: store });
  assert.match(empty.replies[0].content, /Nobody has reputation yet/);

  store.give({ guildId: "g1", userId: "u2", fromId: "u1", amount: 3 });
  const filled = interactionFor({ commandName: "rep-leaderboard", options: { page: 1 } });
  await runRepCommand(filled, { reputation: store });

  const embed = filled.replies[0].embeds[0].toJSON();
  assert.match(embed.title, /page 1\/1/);
  assert.match(embed.description, /<@u2>/);
  assert.match(embed.description, /3/);
});

test("/rep-reset needs Manage Server and a confirmation", async () => {
  const store = reputation();
  store.give({ guildId: "g1", userId: "u2", fromId: "u1", amount: 2 });

  const denied = interactionFor({
    commandName: "rep-reset",
    can: false,
    options: { member: { id: "u2" }, confirm: true },
  });
  await runRepCommand(denied, { reputation: store });
  assert.match(denied.replies[0].content, /Manage Server/);
  assert.equal(store.score("g1", "u2"), 2);

  const unconfirmed = interactionFor({
    commandName: "rep-reset",
    options: { member: { id: "u2" }, confirm: false },
  });
  await runRepCommand(unconfirmed, { reputation: store });
  assert.match(unconfirmed.replies[0].content, /confirm: true/);
  assert.equal(store.score("g1", "u2"), 2);

  const confirmed = interactionFor({
    commandName: "rep-reset",
    options: { member: { id: "u2" }, confirm: true },
  });
  await runRepCommand(confirmed, { reputation: store });
  assert.match(confirmed.replies[0].content, /Cleared \*\*2\*\*/);
  assert.equal(store.score("g1", "u2"), 0);
});

test("commands that are not reputation commands are left for the other handlers", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runRepCommand(interaction, { reputation: reputation() }), false);
  assert.equal(interaction.replies.length, 0);
});
