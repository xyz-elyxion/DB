import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LEVEL,
  createLevelStore,
  levelFromTotalXp,
  progressBar,
  progressFromTotalXp,
  totalXpForLevel,
  xpForLevel,
} from "../src/lib/levels.js";

function message(id, { guild = "g1", channel = "c1", bot = false, webhookId = null } = {}) {
  return {
    guild: guild ? { id: guild } : null,
    channelId: channel,
    webhookId,
    author: { id, bot },
    channel: { id: channel },
  };
}

function store(options = {}) {
  return createLevelStore({ guildId: "g1", minXp: 15, maxXp: 25, cooldownMs: 60_000, ...options });
}

test("the XP curve grows and inverts cleanly", () => {
  assert.equal(xpForLevel(1), 155);
  assert.equal(xpForLevel(2), 220);
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(1), 155);
  assert.equal(totalXpForLevel(2), 375);

  assert.equal(levelFromTotalXp(0), 0);
  assert.equal(levelFromTotalXp(154), 0);
  assert.equal(levelFromTotalXp(155), 1);
  assert.equal(levelFromTotalXp(375), 2);
  assert.equal(levelFromTotalXp(totalXpForLevel(12)), 12);
  assert.equal(levelFromTotalXp(10 ** 12), MAX_LEVEL, "levels are capped");
});

test("progress splits XP into level, position and percentage", () => {
  assert.deepEqual(progressFromTotalXp(0), {
    level: 0,
    xp: 0,
    into: 0,
    need: 155,
    percent: 0,
  });

  const halfway = progressFromTotalXp(155 + 110);
  assert.equal(halfway.level, 1);
  assert.equal(halfway.into, 110);
  assert.equal(halfway.need, 220);
  assert.equal(halfway.percent, 50);

  assert.equal(progressBar(0), "░░░░░░░░░░░░");
  assert.equal(progressBar(100), "████████████");
  assert.equal(progressBar(50).length, 12);
});

test("a message earns XP within the configured range", () => {
  const low = store({ random: () => 0 });
  const high = store({ random: () => 1 });

  assert.equal(low.handleMessage(message("u1"), { now: 1_000 }).amount, 15);
  assert.equal(high.handleMessage(message("u2"), { now: 1_000 }).amount, 25);
  assert.equal(low.get("g1", "u1").xp, 15);
  assert.equal(low.get("g1", "u1").messages, 1);
});

test("the cooldown is per member and survives a restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "levels-"));
  const file = join(directory, "levels.json");

  try {
    const first = createLevelStore({ file, guildId: "g1", minXp: 20, maxXp: 20, cooldownMs: 60_000 });
    assert.ok(first.handleMessage(message("u1"), { now: 1_000 }));
    assert.equal(first.handleMessage(message("u1"), { now: 30_000 }), null, "inside the cooldown");
    assert.ok(first.handleMessage(message("u1"), { now: 61_000 }), "after the cooldown");
    assert.ok(first.handleMessage(message("u2"), { now: 61_000 }), "cooldown is per member");

    const second = createLevelStore({ file, guildId: "g1", minXp: 20, maxXp: 20, cooldownMs: 60_000 });
    assert.equal(second.get("g1", "u1").xp, 40, "XP is persisted");
    assert.equal(
      second.handleMessage(message("u1"), { now: 62_000 }),
      null,
      "the saved timestamp still applies after a restart",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("messages that should not earn XP are ignored", () => {
  const levels = store({ minXp: 20, maxXp: 20 });

  assert.equal(levels.handleMessage(message("bot", { bot: true })), null);
  assert.equal(levels.handleMessage(message("hook", { webhookId: "w1" })), null);
  assert.equal(levels.handleMessage(message("dm", { guild: null })), null);
  assert.equal(levels.handleMessage(message("other", { guild: "g2" })), null, "only the main server");
  assert.equal(levels.handleMessage(null), null);

  levels.toggleNoXpChannel("g1", "c-quiet");
  assert.equal(levels.handleMessage(message("u1", { channel: "c-quiet" })), null);
  assert.ok(levels.handleMessage(message("u1", { channel: "c1" })));

  levels.setEnabled("g1", false);
  assert.equal(levels.handleMessage(message("u2")), null);
  levels.setEnabled("g1", true);
  assert.ok(levels.handleMessage(message("u2")));
});

test("crossing a level boundary is reported once", () => {
  const levels = store({ minXp: 200, maxXp: 200, cooldownMs: 0 });

  const first = levels.handleMessage(message("u1"), { now: 1_000 });
  assert.equal(first.level, 1);
  assert.equal(first.leveledUp, true);
  assert.equal(first.previousLevel, 0);

  const second = levels.handleMessage(message("u1"), { now: 2_000 });
  assert.equal(second.level, 2);
  assert.equal(second.leveledUp, true);

  const third = levels.handleMessage(message("u1"), { now: 3_000 });
  assert.equal(third.level, 2);
  assert.equal(third.leveledUp, false, "no announcement without a new level");
});

test("the leaderboard ranks by XP, pages, and knows each member's place", () => {
  const levels = store();

  levels.addXp({ guildId: "g1", userId: "u1", amount: totalXpForLevel(5) });
  levels.addXp({ guildId: "g1", userId: "u2", amount: totalXpForLevel(9) });
  levels.addXp({ guildId: "g1", userId: "u3", amount: totalXpForLevel(3) });

  const board = levels.leaderboard("g1", { pageSize: 2 });
  assert.equal(board.total, 3);
  assert.equal(board.pages, 2);
  assert.deepEqual(
    board.entries.map((entry) => [entry.userId, entry.rank]),
    [
      ["u2", 1],
      ["u1", 2],
    ],
  );

  const second = levels.leaderboard("g1", { page: 2, pageSize: 2 });
  assert.deepEqual(second.entries.map((entry) => entry.userId), ["u3"]);
  assert.equal(second.page, 2);

  assert.equal(levels.rank("g1", "u2"), 1);
  assert.equal(levels.rank("g1", "u3"), 3);
  assert.equal(levels.rank("g1", "nobody"), 0);
  assert.equal(levels.count("g1"), 3);
});

test("staff can add, set and reset XP", () => {
  const levels = store();

  const added = levels.addXp({ guildId: "g1", userId: "u1", amount: 1000 });
  assert.equal(added.xp, 1000);
  assert.equal(added.level, levelFromTotalXp(1000));
  assert.equal(added.gained, 1000);

  const removed = levels.addXp({ guildId: "g1", userId: "u1", amount: -2000 });
  assert.equal(removed.xp, 0, "XP never goes negative");
  assert.equal(removed.gained, -1000);

  const set = levels.setLevel({ guildId: "g1", userId: "u1", level: 7 });
  assert.equal(set.level, 7);
  assert.equal(set.xp, totalXpForLevel(7));

  const capped = levels.setLevel({ guildId: "g1", userId: "u1", level: MAX_LEVEL + 100 });
  assert.equal(capped.level, MAX_LEVEL);

  assert.equal(levels.reset("g1", "u1"), true);
  assert.equal(levels.get("g1", "u1").level, 0);
  assert.equal(levels.reset("g1", "u1"), false, "nothing left to reset");
});

test("level settings hold role rewards, no-XP channels and the announce channel", () => {
  const levels = store();

  assert.deepEqual(levels.settings("g1"), {
    enabled: true,
    noXpChannels: [],
    roleRewards: {},
    announceChannelId: null,
  });

  levels.setRoleReward("g1", 5, "role-a");
  levels.setRoleReward("g1", 10, "role-b");
  assert.deepEqual(levels.rolesFor("g1", 1), []);
  assert.deepEqual(levels.rolesFor("g1", 5), ["role-a"]);
  assert.deepEqual(levels.rolesFor("g1", 50), ["role-a", "role-b"]);

  levels.setRoleReward("g1", 5, null);
  assert.deepEqual(levels.rolesFor("g1", 5), []);

  const toggled = levels.toggleNoXpChannel("g1", "c-quiet");
  assert.deepEqual(toggled, { enabled: true, channels: ["c-quiet"] });
  assert.equal(levels.settings("g1").noXpChannels.includes("c-quiet"), true);
  assert.equal(levels.toggleNoXpChannel("g1", "c-quiet").enabled, false);
  assert.deepEqual(levels.settings("g1").noXpChannels, []);

  levels.setAnnounceChannel("g1", "c-levels");
  assert.equal(levels.settings("g1").announceChannelId, "c-levels");
  levels.setAnnounceChannel("g1", null);
  assert.equal(levels.settings("g1").announceChannelId, null);
});

test("levels and settings are written to disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "levels-save-"));
  const file = join(directory, "nested", "levels.json");

  try {
    const first = store({ file });
    first.addXp({ guildId: "g1", userId: "u1", amount: 500 });
    first.setRoleReward("g1", 3, "role-a");
    first.setAnnounceChannel("g1", "c-levels");

    const second = store({ file });
    assert.equal(second.get("g1", "u1").xp, 500);
    assert.deepEqual(second.rolesFor("g1", 3), ["role-a"]);
    assert.equal(second.settings("g1").announceChannelId, "c-levels");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
