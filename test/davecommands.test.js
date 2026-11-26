import test from "node:test";
import assert from "node:assert/strict";
import { DAVE_COMMANDS, runDaveCommand } from "../src/lib/davecommands.js";
import { KEY_PATTERN, createDaveKeyStore } from "../src/lib/davekeys.js";

const USER_ID = "111111111111111111";

function interactionFor({
  commandName = "dave-key",
  can = true,
  user = { id: USER_ID },
  userId = null,
  note = null,
} = {}) {
  const replies = [];

  return {
    commandName,
    guild: { id: "main", name: "Main Server" },
    guildId: "main",
    user: { id: "mod", username: "Moderator" },
    member: { id: "mod", permissions: { has: () => can } },
    options: {
      getUser(name, required) {
        if (name === "user") return user;
        if (required) throw new Error(`missing ${name}`);
        return null;
      },
      getString(name) {
        if (name === "note") return note;
        if (name === "user-id") return userId;
        return null;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test("there is one Dave command and its payload is valid for Discord", () => {
  assert.deepEqual(
    DAVE_COMMANDS.map((command) => command.name),
    ["dave-key"],
  );

  const json = DAVE_COMMANDS[0].toJSON();
  assert.equal(json.name, "dave-key");
  assert.ok(json.description.length <= 100);
  assert.deepEqual(
    json.options.map((option) => option.name),
    ["user", "user-id", "note"],
  );
  for (const option of json.options) {
    assert.ok(option.description.length <= 100);
  }
});

test("/dave-key is left for other handlers when it isn't the command", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runDaveCommand(interaction, { keys: createDaveKeyStore() }), false);
  assert.equal(interaction.replies.length, 0);
});

test("/dave-key needs Manage Server", async () => {
  const keys = createDaveKeyStore();
  const interaction = interactionFor({ can: false });

  assert.equal(await runDaveCommand(interaction, { keys }), true);
  assert.match(interaction.replies[0].content, /Manage Server/);
  assert.equal(keys.count(), 0);
});

test("/dave-key accepts a pasted user ID for someone outside the server", async () => {
  const keys = createDaveKeyStore();
  const interaction = interactionFor({ user: null, userId: "987654321098765432" });

  assert.equal(await runDaveCommand(interaction, { keys }), true);
  assert.match(interaction.replies[0].content, /<@987654321098765432>/);

  const bad = interactionFor({ user: null, userId: "not-an-id" });
  await runDaveCommand(bad, { keys: createDaveKeyStore() });
  assert.match(bad.replies[0].content, /15–20 digits/);

  const none = interactionFor({ user: null });
  await runDaveCommand(none, { keys: createDaveKeyStore() });
  assert.match(none.replies[0].content, /Pick the user/);
});

test("/dave-key gives the manager a private key for that person", async () => {
  const keys = createDaveKeyStore();
  const interaction = interactionFor({ user: { id: USER_ID }, note: "Outside server" });

  assert.equal(await runDaveCommand(interaction, { keys }), true);

  const reply = interaction.replies[0];
  assert.equal(reply.flags, 64, "private");
  assert.match(reply.content, new RegExp(`One-time key for <@${USER_ID}>`));
  assert.match(reply.content, /Dave <key>|Dave /);

  const match = /`([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})`/.exec(reply.content);
  assert.ok(match, "the reply shows a key");
  assert.match(match[1], KEY_PATTERN);

  assert.equal(keys.authorize(match[1], USER_ID).ok, true);
  assert.equal(keys.authorize(match[1], "222222222222222222").ok, false);
  assert.equal(keys.count(), 1);
});
