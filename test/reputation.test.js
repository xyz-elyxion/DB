import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_AMOUNT,
  createReputationStore,
  normalizeRepNote,
  parseRepAmount,
} from "../src/lib/reputation.js";

const DAY = 24 * 60 * 60 * 1000;

function store({ now = () => 1_000_000, ...options } = {}) {
  return createReputationStore({ guildId: "g1", now, ...options });
}

test("a member with no reputation reads as zero", () => {
  const reputation = store();
  const entry = reputation.get("g1", "u1");

  assert.equal(entry.score, 0);
  assert.deepEqual(entry.entries, []);
  assert.equal(reputation.score("g1", "u1"), 0);
  assert.equal(reputation.count("g1"), 0);
  assert.equal(reputation.rank("g1", "u1"), null);
});

test("/rep points add up and keep the reason", () => {
  const reputation = store();

  const first = reputation.give({ guildId: "g1", userId: "u2", fromId: "u1", note: "helped me" });
  assert.equal(first.before, 0);
  assert.equal(first.entry.score, 1);
  assert.equal(first.entry.entries[0].note, "helped me");
  assert.equal(first.entry.entries[0].fromId, "u1");

  reputation.give({ guildId: "g1", userId: "u2", fromId: "u3" });
  assert.equal(reputation.score("g1", "u2"), 2);
  assert.equal(reputation.count("g1"), 1, "one member with reputation");
});

test("nobody can give themselves reputation", () => {
  const reputation = store();
  assert.throws(
    () => reputation.give({ guildId: "g1", userId: "u1", fromId: "u1" }),
    /can't give reputation to yourself/,
  );
  assert.equal(reputation.score("g1", "u1"), 0);
});

test("one point per member per day, but other members can still give", () => {
  let now = 1_000_000;
  const reputation = store({ now: () => now });
  reputation.give({ guildId: "g1", userId: "u2", fromId: "u1" });

  assert.throws(
    () => reputation.give({ guildId: "g1", userId: "u2", fromId: "u1" }),
    /already gave reputation/,
  );
  assert.equal(reputation.score("g1", "u2"), 1);

  reputation.give({ guildId: "g1", userId: "u2", fromId: "u3" });
  assert.equal(reputation.score("g1", "u2"), 2, "someone else is not on cooldown");

  now += DAY;
  reputation.give({ guildId: "g1", userId: "u2", fromId: "u1" });
  assert.equal(reputation.score("g1", "u2"), 3, "the cooldown has passed");
});

test("amounts and notes are validated", () => {
  const reputation = store();

  assert.equal(parseRepAmount(undefined), 1);
  assert.equal(parseRepAmount("5"), 5);
  assert.equal(parseRepAmount(-3), -3);
  assert.throws(() => parseRepAmount(0), /change nothing/);
  assert.throws(() => parseRepAmount("two"), /whole number/);
  assert.throws(() => parseRepAmount("1.5"), /whole number/);
  assert.throws(() => parseRepAmount(MAX_AMOUNT + 1), /at most/);

  assert.equal(normalizeRepNote("  spaced   out "), "spaced out");
  assert.equal(normalizeRepNote(""), null);
  assert.throws(() => normalizeRepNote("x".repeat(201)), /at most 200 characters/);

  reputation.give({ guildId: "g1", userId: "u2", fromId: "u1", amount: 4 });
  assert.equal(reputation.score("g1", "u2"), 4);
});

test("managers can take points away with a negative amount", () => {
  const reputation = store();
  reputation.give({ guildId: "g1", userId: "u2", fromId: "u1", amount: 5 });
  reputation.give({ guildId: "g1", userId: "u2", fromId: "mod", amount: -2 });

  assert.equal(reputation.score("g1", "u2"), 3);
  assert.equal(reputation.get("g1", "u2").entries[0].amount, -2);
});

test("the leaderboard ranks the highest scores, with pages", () => {
  const reputation = store();
  reputation.give({ guildId: "g1", userId: "a", fromId: "x", amount: 3 });
  reputation.give({ guildId: "g1", userId: "b", fromId: "x", amount: 7 });
  reputation.give({ guildId: "g1", userId: "c", fromId: "x", amount: 5 });
  reputation.give({ guildId: "g1", userId: "d", fromId: "x", amount: 1 });

  const board = reputation.top("g1", { limit: 2 });
  assert.deepEqual(
    board.entries.map((entry) => [entry.userId, entry.score, entry.rank]),
    [
      ["b", 7, 1],
      ["c", 5, 2],
    ],
  );
  assert.equal(board.pages, 2);
  assert.equal(board.total, 4);

  const second = reputation.top("g1", { limit: 2, page: 2 });
  assert.deepEqual(
    second.entries.map((entry) => entry.userId),
    ["a", "d"],
  );
  assert.equal(reputation.rank("g1", "c"), 2);
});

test("resetting wipes one member and reports what was cleared", () => {
  const reputation = store();
  reputation.give({ guildId: "g1", userId: "u2", fromId: "u1", amount: 3 });

  assert.equal(reputation.reset("g1", "u2", { by: "mod" }), 3);
  assert.equal(reputation.score("g1", "u2"), 0);
  assert.deepEqual(reputation.get("g1", "u2").entries, []);
  assert.equal(reputation.reset("g1", "nobody"), null);
});

test("reputation survives a restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "rep-"));
  const file = join(folder, "reputation.json");

  try {
    const first = createReputationStore({ file, guildId: "g1", now: () => 5_000 });
    first.give({ guildId: "g1", userId: "u2", fromId: "u1", note: "great work" });
    first.give({ guildId: "g1", userId: "u3", fromId: "u1", amount: 2 });

    const again = createReputationStore({ file, guildId: "g1", now: () => 5_000 });
    assert.equal(again.score("g1", "u2"), 1);
    assert.equal(again.get("g1", "u2").entries[0].note, "great work");
    assert.equal(again.score("g1", "u3"), 2);
    assert.equal(again.score("g2", "u2"), 0, "servers are separate");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
