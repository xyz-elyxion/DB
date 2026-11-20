import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaseStore } from "../src/lib/cases.js";
import { MAX_TIMEOUT_MS, formatDuration, parseDuration } from "../src/lib/duration.js";
import {
  MOD_COMMANDS,
  assertCanModerate,
  runModerationCommand,
  selectPurgeable,
} from "../src/lib/moderation.js";

test("parseDuration reads plain numbers as minutes", () => {
  assert.equal(parseDuration("30"), 1_800_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration(" 45 S "), 45_000);
});

test("parseDuration rejects nonsense instead of guessing", () => {
  for (const value of ["", "   ", "abc", "10x", "0m", "-5m", "1.5h", null, undefined]) {
    assert.equal(parseDuration(value), null, `${value} should not parse`);
  }
});

test("formatDuration reads back like a human wrote it", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(5_400_000), "1h 30m");
  assert.equal(formatDuration(MAX_TIMEOUT_MS), "28d");
});

test("timeouts are capped at 28 days", () => {
  assert.equal(MAX_TIMEOUT_MS, 28 * 86_400_000);
});

test("cases are numbered, filtered by user and type, and removed on request", () => {
  const store = createCaseStore();

  const first = store.add({ guildId: "g1", type: "warn", targetId: "u1", reason: "spam" });
  const second = store.add({ guildId: "g1", type: "warn", targetId: "u1", reason: "again" });
  const other = store.add({ guildId: "g1", type: "ban", targetId: "u1", reason: "enough" });

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(other.id, 3);

  assert.equal(store.get("g1", 2).reason, "again");
  assert.equal(store.get("g2", 2), null, "cases are scoped to one server");
  assert.equal(store.forUser("g1", "u1", "warn").length, 2);
  assert.equal(store.forUser("g1", "u1").length, 3);

  assert.equal(store.remove("g1", 2), true);
  assert.equal(store.get("g1", 2), null);
  assert.equal(store.remove("g1", 2), false);

  assert.equal(store.clearForUser("g1", "u1", "warn"), 1);
  assert.equal(store.forUser("g1", "u1").length, 1);
  assert.equal(store.count, 1);
});

test("cases are written to disk and read back by a new store", () => {
  const directory = mkdtempSync(join(tmpdir(), "cases-"));
  const file = join(directory, "nested", "cases.json");

  try {
    const first = createCaseStore({ file });
    first.add({ guildId: "g1", type: "warn", targetId: "u1", reason: "spam" });

    const second = createCaseStore({ file });
    assert.equal(second.count, 1);
    assert.equal(second.get("g1", 1).reason, "spam");

    const third = second.add({ guildId: "g1", type: "kick", targetId: "u2", reason: "rule 4" });
    assert.equal(third.id, 2, "numbering continues after a restart");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selectPurgeable skips messages Discord can no longer bulk delete", () => {
  const now = Date.now();
  const messages = [
    { id: "1", createdTimestamp: now - 60_000, author: { id: "u1" } },
    { id: "2", createdTimestamp: now - 120_000, author: { id: "u2" } },
    { id: "3", createdTimestamp: now - 20 * 86_400_000, author: { id: "u1" } },
  ];

  assert.deepEqual(
    selectPurgeable(messages, { amount: 10, now }).map((message) => message.id),
    ["1", "2"],
  );
  assert.deepEqual(
    selectPurgeable(messages, { amount: 10, userId: "u1", now }).map((message) => message.id),
    ["1"],
  );
  assert.equal(selectPurgeable(messages, { amount: 1, now }).length, 1);
});

function moderationGuild() {
  const bans = [];
  const target = {
    id: "bad",
    user: { id: "bad", tag: "bad#0001", username: "bad" },
    roles: { highest: { position: 1 } },
    async kick(reason) {
      target.kickedWith = reason;
    },
    async timeout(ms, reason) {
      target.timeoutWith = { ms, reason };
    },
  };

  const bot = { id: "bot", roles: { highest: { position: 50 } } };

  const guild = {
    id: "g1",
    name: "Main",
    ownerId: "owner",
    roles: { everyone: { id: "g1" }, cache: new Map() },
    channels: { cache: new Map(), async fetch() { return null; } },
    members: {
      cache: new Map([["bad", target]]),
      me: bot,
      async fetch(id) {
        return id === "bad" ? target : null;
      },
      async ban(id, options) {
        bans.push({ id, options });
      },
    },
  };

  return { guild, bans, target, bot };
}

function moderator({ id = "mod", position = 10, can = true } = {}) {
  return { id, permissions: { has: () => can }, roles: { highest: { position } } };
}

function interactionFor({ commandName, guild, member, options = {}, channel = null }) {
  const replies = [];
  return {
    commandName,
    guild,
    guildId: guild?.id ?? null,
    member,
    channel,
    options: {
      getUser: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test("the bot refuses to moderate itself, the owner or someone ranked above", () => {
  const { guild, target, bot } = moderationGuild();

  assert.throws(
    () => assertCanModerate({ guild, moderator: moderator({ id: "bad" }), target, action: "ban" }),
    /yourself/,
  );
  assert.throws(
    () =>
      assertCanModerate({
        guild: { ...guild, ownerId: "bad" },
        moderator: moderator(),
        target,
        action: "ban",
      }),
    /owner/,
  );
  assert.throws(
    () =>
      assertCanModerate({
        guild,
        moderator: moderator({ position: 1 }),
        target,
        action: "ban",
      }),
    /same as or above/,
  );
  assert.throws(
    () =>
      assertCanModerate({
        guild: { ...guild, members: { ...guild.members, me: { id: "bot", roles: { highest: { position: 1 } } } } },
        moderator: moderator(),
        target,
        action: "ban",
      }),
    /My role/,
  );
  assert.doesNotThrow(() =>
    assertCanModerate({ guild, moderator: moderator(), target, action: "ban" }),
  );
  assert.equal(bot.id, "bot");
});

test("a ban replies privately and leaves a case behind", async () => {
  const { guild, bans } = moderationGuild();
  const cases = createCaseStore();

  const interaction = interactionFor({
    commandName: "ban",
    guild,
    member: moderator(),
    options: { member: { id: "bad", tag: "bad#0001" }, reason: "spam", delete_days: 2 },
  });

  assert.equal(await runModerationCommand(interaction, { cases }), true);

  assert.equal(bans[0].id, "bad");
  assert.equal(bans[0].options.reason, "spam");
  assert.equal(bans[0].options.deleteMessageSeconds, 2 * 86_400);

  assert.match(interaction.replies[0].content, /Banned/);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral, "replies are private");

  const record = cases.get("g1", 1);
  assert.equal(record.type, "ban");
  assert.equal(record.targetId, "bad");
  assert.equal(record.moderatorId, "mod");
  assert.ok(record.at);
});

test("a timeout uses the parsed duration", async () => {
  const { guild, target } = moderationGuild();
  const cases = createCaseStore();

  await runModerationCommand(
    interactionFor({
      commandName: "timeout",
      guild,
      member: moderator(),
      options: { member: { id: "bad", tag: "bad#0001" }, duration: "2h" },
    }),
    { cases },
  );

  assert.deepEqual(target.timeoutWith, { ms: 7_200_000, reason: "No reason given" });
  assert.equal(cases.forUser("g1", "bad", "timeout").length, 1);
});

test("missing permissions are explained and nothing happens", async () => {
  const { guild, bans } = moderationGuild();
  const cases = createCaseStore();

  const interaction = interactionFor({
    commandName: "ban",
    guild,
    member: moderator({ can: false }),
    options: { member: { id: "bad", tag: "bad#0001" } },
  });

  await runModerationCommand(interaction, { cases });

  assert.equal(bans.length, 0);
  assert.match(interaction.replies[0].content, /Ban Members/);
  assert.equal(cases.count, 0);
});

test("unknown commands are left alone", async () => {
  const { guild } = moderationGuild();
  const interaction = interactionFor({ commandName: "ship", guild, member: moderator() });

  assert.equal(await runModerationCommand(interaction, { cases: createCaseStore() }), false);
  assert.equal(interaction.replies.length, 0);
});

test("the command set is complete and self-describing", () => {
  const names = MOD_COMMANDS.map((command) => command.name);

  assert.deepEqual(
    names.slice().sort(),
    [
      "ban",
      "case",
      "clearwarnings",
      "kick",
      "lock",
      "purge",
      "slowmode",
      "timeout",
      "unban",
      "unlock",
      "untimeout",
      "warn",
      "warnings",
    ],
  );
  assert.equal(new Set(names).size, names.length, "no duplicate command names");

  for (const command of MOD_COMMANDS) {
    const json = command.toJSON();
    assert.ok(json.description.length > 5, `${command.name} needs a description`);
    assert.ok(json.default_member_permissions, `${command.name} should be staff-only`);
  }
});
