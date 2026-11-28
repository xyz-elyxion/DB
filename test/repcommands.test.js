import test from "node:test";
import assert from "node:assert/strict";
import { REP_COMMANDS, runRepCommand } from "../src/lib/repcommands.js";
import { createUserStore } from "../src/lib/users.js";

const FIELDS = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  username: "ada.l",
  dateOfBirth: "1990-12-10",
  class: "10A",
  gender: "Female",
  roles: "Student",
};

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

/** A database with a record for the member "u2". */
function database(extra = {}) {
  const users = createUserStore({ guildId: "g1" });
  users.create({ guildId: "g1", userId: "u2", ...FIELDS, ...extra });
  return users;
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

test("/rep gives a point on the record and is private by default", async () => {
  const users = database();
  const interaction = interactionFor({
    commandName: "rep",
    options: { member: { id: "u2" }, note: "helped with homework" },
  });

  assert.equal(await runRepCommand(interaction, { users }), true);

  const stored = users.get("g1", "u2");
  assert.equal(stored.reputation.score, 1);
  assert.equal(stored.reputation.entries[0].note, "helped with homework");
  assert.match(interaction.replies[0].content, /\+1/);
  assert.match(interaction.replies[0].content, /\*\*1\*\*/);
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("/rep asks for a record before giving reputation", async () => {
  const users = database();
  const interaction = interactionFor({
    commandName: "rep",
    options: { member: { id: "u9" } },
  });

  await runRepCommand(interaction, { users });
  assert.match(interaction.replies[0].content, /isn't in the database yet/);
  assert.match(interaction.replies[0].content, /\/create-user/);
});

test("/rep refuses a member who tries to rep their own record", async () => {
  const users = database();
  users.create({
    guildId: "g1",
    userId: "mod",
    ...FIELDS,
    username: "mod",
    email: "mod@example.com",
  });

  const interaction = interactionFor({ commandName: "rep", options: { member: { id: "mod" } } });
  await runRepCommand(interaction, { users });

  assert.match(interaction.replies[0].content, /can't give reputation to yourself/);
  assert.equal(users.get("g1", "mod").reputation.score, 0);
});

test("/rep-info shows the score, rank and recent reasons", async () => {
  const users = database();
  users.addReputation({ guildId: "g1", recordId: "u2", fromId: "u1", note: "great" });
  users.addReputation({ guildId: "g1", recordId: "u2", fromId: "u3", note: "helpful" });

  const interaction = interactionFor({
    commandName: "rep-info",
    options: { member: { id: "u2" } },
  });
  await runRepCommand(interaction, { users });

  const embed = interaction.replies[0].embeds[0].toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Points, "2");
  assert.equal(fields.Rank, "#1 of 1");
  assert.match(embed.description, /great/);
  assert.match(embed.description, /helpful/);
});

test("/rep-leaderboard handles an empty board and a full one", async () => {
  const users = database();
  const empty = interactionFor({ commandName: "rep-leaderboard", options: {} });
  await runRepCommand(empty, { users });
  assert.match(empty.replies[0].content, /Nobody has reputation yet/);

  users.addReputation({ guildId: "g1", recordId: "u2", fromId: "u1", amount: 3 });
  const filled = interactionFor({ commandName: "rep-leaderboard", options: { page: 1 } });
  await runRepCommand(filled, { users });

  const embed = filled.replies[0].embeds[0].toJSON();
  assert.match(embed.title, /page 1\/1/);
  assert.match(embed.description, /<@u2>/);
  assert.match(embed.description, /3/);
});

test("/rep-reset needs Manage Server and a confirmation", async () => {
  const users = database();
  users.addReputation({ guildId: "g1", recordId: "u2", fromId: "u1", amount: 2 });

  const denied = interactionFor({
    commandName: "rep-reset",
    can: false,
    options: { member: { id: "u2" }, confirm: true },
  });
  await runRepCommand(denied, { users });
  assert.match(denied.replies[0].content, /Manage Server/);
  assert.equal(users.get("g1", "u2").reputation.score, 2);

  const unconfirmed = interactionFor({
    commandName: "rep-reset",
    options: { member: { id: "u2" }, confirm: false },
  });
  await runRepCommand(unconfirmed, { users });
  assert.match(unconfirmed.replies[0].content, /confirm: true/);
  assert.equal(users.get("g1", "u2").reputation.score, 2);

  const confirmed = interactionFor({
    commandName: "rep-reset",
    options: { member: { id: "u2" }, confirm: true },
  });
  await runRepCommand(confirmed, { users });
  assert.match(confirmed.replies[0].content, /Cleared \*\*2\*\*/);
  assert.equal(users.get("g1", "u2").reputation.score, 0);
});

test("commands that are not reputation commands are left for the other handlers", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runRepCommand(interaction, { users: database() }), false);
  assert.equal(interaction.replies.length, 0);
});
