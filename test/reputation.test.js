import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REPUTATION,
  normalizeReputation,
  parseReputation,
} from "../src/lib/reputation.js";
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

test("reputation reads as a whole number, however it was saved", () => {
  assert.equal(normalizeReputation(undefined), 0);
  assert.equal(normalizeReputation(4), 4);
  assert.equal(normalizeReputation("7"), 7);
  assert.equal(normalizeReputation({ score: 6 }), 6, "older saves held an object");
  assert.equal(normalizeReputation({ score: "x" }), 0);
});

test("points typed into a command have to be a whole number in range", () => {
  assert.equal(parseReputation(undefined), 0);
  assert.equal(parseReputation("5"), 5);
  assert.equal(parseReputation(0), 0);
  assert.throws(() => parseReputation("two"), /whole number/);
  assert.throws(() => parseReputation(1.5), /whole number/);
  assert.throws(() => parseReputation(-1), /between 0 and/);
  assert.throws(() => parseReputation(MAX_REPUTATION + 1), /between 0 and/);
});

test("reputation is a field on the record, changed like the rest of it", () => {
  const users = createUserStore({ guildId: "g1" });
  const ada = users.create({ guildId: "g1", userId: "u2", ...FIELDS, reputation: 3 });
  assert.equal(ada.reputation, 3, "staff can start a record with points");

  const { record, changed } = users.update({ guildId: "g1", recordId: ada.id, reputation: 9 });
  assert.deepEqual(changed, ["reputation"]);
  assert.equal(record.reputation, 9);
  assert.equal(users.get("g1", "u2").reputation, 9);

  users.update({ guildId: "g1", recordId: ada.id, reputation: 0 });
  assert.equal(users.get("g1", "u2").reputation, 0, "zero clears the points");
});

test("records start at zero and the points survive a restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "rep-"));
  const file = join(folder, "users.json");

  try {
    const users = createUserStore({ file, guildId: "g1" });
    const ada = users.create({ guildId: "g1", userId: "u2", ...FIELDS });
    assert.equal(ada.reputation, 0);

    users.update({ guildId: "g1", recordId: ada.id, reputation: 12 });

    const again = createUserStore({ file, guildId: "g1" });
    assert.equal(again.get("g1", "u2").reputation, 12);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("old saves load their score, and records with none read zero", () => {
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
              reputation: { score: 5, entries: [], givers: {} },
            },
            u3: {
              id: "u3",
              userId: "u3",
              firstName: "Grace",
              lastName: "Hopper",
              email: "grace@example.com",
              username: "grace.h",
              class: "11B",
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
    assert.equal(users.get("g1", "u2").reputation, 5);
    assert.equal(users.get("g1", "u3").reputation, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
