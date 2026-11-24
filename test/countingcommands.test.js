import test from "node:test";
import assert from "node:assert/strict";
import { COUNTING_COMMANDS, runCountingCommand } from "../src/lib/countingcommands.js";
import { createCountingStore } from "../src/lib/counting.js";

function guild() {
  return { id: "g1", name: "Main" };
}

function interactionFor({ commandName, options = {}, can = true, guild: target = guild() }) {
  const replies = [];
  return {
    commandName,
    guild: target,
    guildId: target?.id ?? null,
    member: { id: "mod", permissions: { has: () => can } },
    options: { getChannel: (name) => options[name] ?? null },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

function counting() {
  return createCountingStore({ guildId: "g1" });
}

test("there is a command for setup, disabling, resetting and stats", () => {
  const names = COUNTING_COMMANDS.map((command) => command.name).sort();
  assert.deepEqual(names, [
    "counting-disable",
    "counting-reset",
    "counting-setup",
    "counting-stats",
  ]);
});

test("setup needs Manage Server and picks the channel", async () => {
  const store = counting();
  const denied = interactionFor({
    commandName: "counting-setup",
    can: false,
    options: { channel: { id: "c1" } },
  });
  await runCountingCommand(denied, { counting: store });
  assert.match(denied.replies[0].content, /Manage Server/);
  assert.equal(store.settings().channelId, null);

  const interaction = interactionFor({
    commandName: "counting-setup",
    options: { channel: { id: "c1", name: "counting" } },
  });
  assert.equal(await runCountingCommand(interaction, { counting: store }), true);
  assert.equal(store.settings().channelId, "c1");
  assert.match(interaction.replies[0].content, /<#c1>/);
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("setup on another channel starts the count over", async () => {
  const store = counting();
  store.setChannel("g1", "c1");
  store.handleMessage({
    guild: { id: "g1" },
    channelId: "c1",
    content: "1",
    author: { id: "u1" },
  });

  await runCountingCommand(
    interactionFor({ commandName: "counting-setup", options: { channel: { id: "c2" } } }),
    { counting: store },
  );

  assert.equal(store.settings().channelId, "c2");
  assert.equal(store.settings().count, 0);
});

test("/counting-reset starts at 1 and keeps the record", async () => {
  const store = counting();
  store.setChannel("g1", "c1");
  store.handleMessage({ guild: { id: "g1" }, channelId: "c1", content: "1", author: { id: "u1" } });
  store.handleMessage({ guild: { id: "g1" }, channelId: "c1", content: "2", author: { id: "u2" } });

  const interaction = interactionFor({ commandName: "counting-reset" });
  await runCountingCommand(interaction, { counting: store });

  assert.equal(store.settings().next, 1);
  assert.equal(store.settings().record, 2);
  assert.match(interaction.replies[0].content, /next number is \*\*1\*\*/);
});

test("/counting-disable turns it off and reports where the chain stopped", async () => {
  const store = counting();
  store.setChannel("g1", "c1");
  store.handleMessage({ guild: { id: "g1" }, channelId: "c1", content: "1", author: { id: "u1" } });

  const interaction = interactionFor({ commandName: "counting-disable" });
  await runCountingCommand(interaction, { counting: store });

  assert.equal(store.settings().enabled, false);
  assert.match(interaction.replies[0].content, /stopped at \*\*1\*\*/);
});

test("/counting-stats shows the count, next number, best and last counter", async () => {
  const store = counting();
  store.setChannel("g1", "c1");
  store.handleMessage({ guild: { id: "g1" }, channelId: "c1", content: "1", author: { id: "u1" } });

  const interaction = interactionFor({ commandName: "counting-stats" });
  await runCountingCommand(interaction, { counting: store });

  const embed = interaction.replies[0].embeds[0].toJSON();
  assert.equal(embed.title, "Counting");
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Channel, "<#c1>");
  assert.equal(fields.Current, "1");
  assert.equal(fields["Next number"], "2");
  assert.equal(fields["Last counter"], "<@u1>");

  const off = interactionFor({ commandName: "counting-stats" });
  await runCountingCommand(off, { counting: counting() });
  assert.match(off.replies[0].content, /isn't set up/);
});

test("commands that are not counting commands are left for the other handlers", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runCountingCommand(interaction, { counting: counting() }), false);
  assert.equal(interaction.replies.length, 0);
});
