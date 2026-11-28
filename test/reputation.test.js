import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_AMOUNT,
  emptyReputation,
  giveReputation,
  normalizeRepNote,
  parseRepAmount,
  readReputation,
  reputationBoard,
  reputationRank,
} from "../src/lib/reputation.js";
import { createUserStore } from "../src/lib/users.js";

const DAY = 24 * 60 * 60 * 1000;

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

function record(overrides = {}) {
  return {
    id: "u2",
    userId: "u2",
    firstName: "Ada",
    lastName: "Lovelace",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("a record with no reputation reads as zero, in the same shape", () => {
  assert.deepEqual(readReputation(record()), emptyReputation());
  assert.deepEqual(readReputation({ reputation: 4 }).score, 4, "a plain number still reads");
  assert.equal(readReputation({ reputation: { score: "x" } }).score, 0);
});

test("reputation points add up and keep the reason", () => {
  const first = giveReputation(record(), { fromId: "u1", note: "helped me", now: 1_000 });

  assert.equal(first.before, 0);
  assert.equal(first.reputation.score, 1);
  assert.equal(first.reputation.entries[0].note, "helped me");
  assert.equal(first.reputation.entries[0].fromId, "u1");

  const second = giveReputation(
    record({ reputation: first.reputation }),
    { fromId: "u3", now: 2_000 },
  );
  assert.equal(second.reputation.score, 2);
  assert.equal(second.reputation.entries.length, 2);
});

test("nobody can give themselves reputation", () => {
  assert.throws(
    () => giveReputation(record(), { fromId: "u2" }),
    /can't give reputation to yourself/,
  );
});

test("one point per member per record per day, but other members can still give", () => {
  const first = giveReputation(record(), { fromId: "u1", now: 1_000 });
  assert.throws(
    () => giveReputation(record({ reputation: first.reputation }), { fromId: "u1", now: 2_000 }),
    /already gave reputation/,
  );

  const other = giveReputation(record({ reputation: first.reputation }), {
    fromId: "u3",
    now: 2_000,
  });
  assert.equal(other.reputation.score, 2, "someone else is not on cooldown");

  const later = giveReputation(record({ reputation: other.reputation }), {
    fromId: "u1",
    now: 2_000 + DAY,
  });
  assert.equal(later.reputation.score, 3, "the cooldown has passed");
});

test("amounts and notes are validated", () => {
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

  const result = giveReputation(record(), { fromId: "u1", amount: 4 });
  assert.equal(result.reputation.score, 4);
});

test("managers can take points away with a negative amount", () => {
  const added = giveReputation(record(), { fromId: "u1", amount: 5, now: 1_000 });
  const taken = giveReputation(record({ reputation: added.reputation }), {
    fromId: "mod",
    amount: -2,
    now: 2_000,
  });

  assert.equal(taken.reputation.score, 3);
  assert.equal(taken.reputation.entries[0].amount, -2);
});

test("the board ranks the highest scores, with pages", () => {
  const records = [
    record({ id: "a", userId: "a", reputation: { score: 3 } }),
    record({ id: "b", userId: "b", reputation: { score: 7 } }),
    record({ id: "c", userId: "c", reputation: { score: 5 } }),
    record({ id: "d", userId: "d", reputation: { score: 1 } }),
    record({ id: "e", userId: "e" }),
  ];

  const board = reputationBoard(records, { limit: 2 });
  assert.deepEqual(
    board.entries.map((entry) => [entry.userId, entry.score, entry.rank]),
    [
      ["b", 7, 1],
      ["c", 5, 2],
    ],
  );
  assert.equal(board.pages, 2);
  assert.equal(board.total, 4, "records with zero points stay off the board");

  assert.deepEqual(
    reputationBoard(records, { limit: 2, page: 2 }).entries.map((entry) => entry.userId),
    ["a", "d"],
  );
  assert.equal(reputationRank(records, "c"), 2);
  assert.equal(reputationRank(records, "e"), null);
});

test("reputation is saved as part of the record, not on the side", () => {
  const folder = mkdtempSync(join(tmpdir(), "rep-"));
  const file = join(folder, "users.json");

  try {
    const users = createUserStore({ file, guildId: "g1" });
    const ada = users.create({ guildId: "g1", userId: "u2", ...FIELDS });
    assert.equal(ada.reputation.score, 0, "a new record starts at zero");

    const given = users.addReputation({
      guildId: "g1",
      recordId: ada.id,
      fromId: "u1",
      note: "great work",
    });
    assert.equal(given.record.reputation.score, 1);
    assert.equal(users.get("g1", "u2").reputation.entries[0].note, "great work");

    const again = createUserStore({ file, guildId: "g1" });
    assert.equal(again.get("g1", "u2").reputation.score, 1, "it survives a restart");
    assert.equal(again.reputationRank("g1", "u2"), 1);

    assert.equal(again.resetReputation({ guildId: "g1", recordId: ada.id }), 1);
    assert.equal(again.get("g1", "u2").reputation.score, 0);
    assert.equal(again.resetReputation({ guildId: "g1", recordId: "nobody" }), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("reputation only works on records that exist", () => {
  const users = createUserStore({ guildId: "g1" });
  assert.throws(
    () => users.addReputation({ guildId: "g1", recordId: "ghost", fromId: "u1" }),
    /doesn't exist/,
  );
});

test("records saved before reputation existed load with zero", () => {
  const folder = mkdtempSync(join(tmpdir(), "rep-"));
  const file = join(folder, "users.json");
  writeFileSync(
    file,
    JSON.stringify({
      guilds: {
        g1: {
          users: {
            u2: {
              id: "u2",
              userId: "u2",
              firstName: "Ada",
              lastName: "Lovelace",
              email: "ada@example.com",
              username: "ada.l",
              class: "10A",
              gender: "Female",
              roles: [],
            },
          },
        },
      },
    }),
  );

  try {
    const users = createUserStore({ file, guildId: "g1" });
    assert.deepEqual(users.get("g1", "u2").reputation, emptyReputation());
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
