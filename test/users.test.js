import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageFromDateOfBirth,
  createUserStore,
  normalizeProfile,
  parseDateOfBirth,
  parseRoles,
} from "../src/lib/users.js";

const FIELDS = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "Ada@Example.com",
  username: "ada.l",
  dateOfBirth: "10/12/1990",
  class: "10A",
  gender: "Female",
  roles: "Student, Prefect, student",
};

test("dates of birth can be ISO or day-first", () => {
  assert.equal(parseDateOfBirth("2005-04-12"), "2005-04-12");
  assert.equal(parseDateOfBirth("12/04/2005"), "2005-04-12");
  assert.equal(parseDateOfBirth("12-04-2005"), "2005-04-12");
  assert.equal(parseDateOfBirth("31/02/2000"), null);
  assert.equal(parseDateOfBirth("2999-01-01"), null);
  assert.equal(parseDateOfBirth("2005-13-01"), null);
  assert.equal(parseDateOfBirth("not a date"), null);
});

test("age is counted in whole years", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  assert.equal(ageFromDateOfBirth("2005-11-25", { now }), 21);
  assert.equal(ageFromDateOfBirth("2005-11-26", { now }), 20);
  assert.equal(ageFromDateOfBirth("nope"), null);
});

test("roles are split, trimmed and de-duplicated", () => {
  assert.deepEqual(parseRoles("Student, Prefect , student"), ["Student", "Prefect"]);
  assert.deepEqual(parseRoles(""), []);
  assert.throws(() => parseRoles("x".repeat(33)), /32 characters or fewer/);
  assert.throws(
    () => parseRoles(Array.from({ length: 11 }, (_, index) => `role${index}`).join(",")),
    /at most 10/,
  );
});

test("a profile is tidied and validated", () => {
  const profile = normalizeProfile(FIELDS);
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.dateOfBirth, "1990-12-10");
  assert.deepEqual(profile.roles, ["Student", "Prefect"]);

  assert.throws(() => normalizeProfile({ ...FIELDS, email: "nope" }), /email/i);
  assert.throws(() => normalizeProfile({ ...FIELDS, username: "no spaces" }), /Username/);
  assert.throws(() => normalizeProfile({ ...FIELDS, dateOfBirth: "2999-01-01" }), /past/);
  assert.throws(() => normalizeProfile({ ...FIELDS, firstName: "   " }), /First name is required/);
  assert.throws(() => normalizeProfile({ ...FIELDS, gender: "" }), /Gender is required/);
});

test("the birthday is optional", () => {
  const profile = normalizeProfile({ ...FIELDS, dateOfBirth: "" });
  assert.equal(profile.dateOfBirth, null);

  const store = createUserStore();
  const record = store.create({ guildId: "g1", ...FIELDS, dateOfBirth: "" });
  assert.equal(record.dateOfBirth, null);
  assert.throws(() => normalizeProfile({ ...FIELDS, dateOfBirth: "nope" }), /real date/);
});

test("creating, finding and persisting records", () => {
  const dir = mkdtempSync(join(tmpdir(), "users-"));
  const file = join(dir, "users.json");

  try {
    const store = createUserStore({ file });
    const record = store.create({ guildId: "g1", userId: "u1", createdBy: "mod", ...FIELDS });

    assert.equal(record.firstName, "Ada");
    assert.equal(store.count("g1"), 1);
    assert.equal(store.get("g1", "u1").username, "ada.l");
    assert.equal(store.findByUsername("g1", "ADA.L").userId, "u1");
    assert.equal(store.findByUsername("g1", "missing"), null);

    const reloaded = createUserStore({ file });
    assert.equal(reloaded.get("g1", "u1").email, "ada@example.com");
    assert.equal(reloaded.get("g2", "u1"), null, "guilds are isolated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records are unique per member, username and email", () => {
  const store = createUserStore();
  store.create({ guildId: "g1", userId: "u1", ...FIELDS });

  assert.throws(
    () => store.create({ guildId: "g1", userId: "u1", ...FIELDS }),
    /already has a record/,
  );
  assert.throws(
    () =>
      store.create({ guildId: "g1", userId: "u2", ...FIELDS, email: "other@example.com" }),
    /already used/,
  );
  assert.throws(
    () => store.create({ guildId: "g1", userId: "u3", ...FIELDS, username: "another" }),
    /already registered/,
  );
});

test("a clash names the person even when their record is unassigned", () => {
  const store = createUserStore();
  store.create({ guildId: "g1", ...FIELDS });

  assert.throws(
    () => store.create({ guildId: "g1", ...FIELDS, email: "other@example.com" }),
    /already used by \*\*Ada Lovelace\*\* \(unassigned\)/,
  );
  assert.throws(
    () => store.create({ guildId: "g1", ...FIELDS, username: "another" }),
    /already registered to \*\*Ada Lovelace\*\* \(unassigned\)/,
  );
});

test("updating only touches the given fields", () => {
  const store = createUserStore();
  store.create({ guildId: "g1", userId: "u1", ...FIELDS });
  const before = store.get("g1", "u1");

  const { record, changed } = store.update({
    guildId: "g1",
    recordId: "u1",
    class: "11B",
    roles: "",
  });

  assert.deepEqual(changed.sort(), ["class", "roles"]);
  assert.equal(record.class, "11B");
  assert.deepEqual(record.roles, []);
  assert.equal(record.email, before.email);
  assert.equal(record.createdAt, before.createdAt);

  assert.throws(
    () => store.update({ guildId: "g1", recordId: "u2", class: "10A" }),
    /doesn't exist/,
  );
  assert.throws(() => store.update({ guildId: "g1", recordId: "u1" }), /at least one field/);
});

test("a record can exist without a member", () => {
  const store = createUserStore();
  const record = store.create({ guildId: "g1", ...FIELDS });

  assert.equal(record.userId, null, "unassigned");
  assert.ok(record.id, "still gets its own id");
  assert.equal(store.get("g1", record.id).username, "ada.l");
  assert.equal(store.findByUsername("g1", "ada.l").id, record.id);

  const { record: updated } = store.update({
    guildId: "g1",
    recordId: record.id,
    class: "11B",
  });
  assert.equal(updated.class, "11B");
  assert.equal(updated.userId, null, "editing does not assign a member");
  assert.equal(store.remove("g1", record.id).id, record.id);
  assert.equal(store.count("g1"), 0);
});

test("removing a record returns it and forgets it", () => {
  const store = createUserStore();
  store.create({ guildId: "g1", userId: "u1", ...FIELDS });

  assert.equal(store.remove("g1", "u1").userId, "u1");
  assert.equal(store.get("g1", "u1"), null);
  assert.equal(store.remove("g1", "u1"), null);
});
