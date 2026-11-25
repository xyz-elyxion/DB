import test from "node:test";
import assert from "node:assert/strict";
import { createUserStore } from "../src/lib/users.js";
import { cleanUserForum, createUserForum } from "../src/lib/userposts.js";
import { runUserCommand } from "../src/lib/usercommands.js";

function fakeWorld({ active = [], archived = [] } = {}) {
  const deletions = [];
  const make = (spec) => ({
    id: spec.id,
    name: spec.name,
    ownerId: spec.ownerId ?? "bot",
    archivedTimestamp: Date.now(),
    async delete(reason) {
      deletions.push({ id: spec.id, reason });
    },
  });

  const activeThreads = active.map(make);
  const archivedThreads = archived.map(make);

  const channel = {
    id: "forum",
    threads: {
      async fetchActive() {
        return { threads: new Map(activeThreads.map((thread) => [thread.id, thread])) };
      },
      async fetchArchived() {
        return {
          threads: new Map(archivedThreads.map((thread) => [thread.id, thread])),
          hasMore: false,
        };
      },
      async create() {
        throw new Error("cleanup never creates posts");
      },
    },
  };

  const guild = {
    id: "g1",
    name: "Main",
    channels: {
      cache: new Map([["forum", channel]]),
      async fetch() {
        return null;
      },
    },
  };

  return { guild, forum: createUserForum({ channelId: "forum" }), deletions };
}

function recordWithPost(forumThreadId) {
  const users = createUserStore({ guildId: "g1" });
  const record = users.create({
    guildId: "g1",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    username: "ada.l",
    dateOfBirth: "1990-12-10",
    class: "10A",
    gender: "Female",
  });
  users.setMeta({ guildId: "g1", recordId: record.id, meta: { forumThreadId } });
  return users;
}

function interactionFor(options, guild) {
  const replies = [];
  return {
    commandName: "clean-user-forum",
    guild,
    guildId: "g1",
    user: { id: "mod", username: "Moderator" },
    member: { id: "mod", permissions: { has: () => true } },
    client: { user: { id: "bot" } },
    options: {
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getUser: () => null,
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test("a dry run lists the posts that have no record and deletes nothing", async () => {
  const users = recordWithPost("t1");
  const { guild, forum, deletions } = fakeWorld({
    active: [
      { id: "t1", name: "Ada Lovelace (ada.l)" },
      { id: "t2", name: "Ghost One" },
    ],
    archived: [{ id: "t3", name: "Ghost Two" }],
  });

  const report = await cleanUserForum({ forum, users, guild, botId: "bot" });

  assert.equal(report.total, 3);
  assert.equal(report.candidates, 2, "the record's own post is kept");
  assert.equal(report.targets, 2);
  assert.equal(report.deleted, 0);
  assert.deepEqual(deletions, []);
  assert.deepEqual(report.sample, ["Ghost One", "Ghost Two"]);
});

test("confirmed cleanup deletes the orphaned posts, active and archived", async () => {
  const users = recordWithPost("t1");
  const { guild, forum, deletions } = fakeWorld({
    active: [
      { id: "t1", name: "Ada Lovelace (ada.l)" },
      { id: "t2", name: "Ghost One" },
    ],
    archived: [{ id: "t3", name: "Ghost Two" }],
  });

  const report = await cleanUserForum({ forum, users, guild, botId: "bot", dryRun: false });

  assert.equal(report.deleted, 2);
  assert.deepEqual(deletions.map((entry) => entry.id).sort(), ["t2", "t3"]);
  assert.equal(users.get("g1", users.all("g1")[0].id).forumThreadId, "t1", "kept record untouched");
});

test("the all mode deletes every post and forgets its thread", async () => {
  const users = recordWithPost("t1");
  const { guild, forum, deletions } = fakeWorld({
    active: [{ id: "t1", name: "Ada Lovelace (ada.l)" }],
  });

  const report = await cleanUserForum({
    forum,
    users,
    guild,
    botId: "bot",
    mode: "all",
    dryRun: false,
  });

  assert.equal(report.deleted, 1);
  assert.deepEqual(deletions.map((entry) => entry.id), ["t1"]);
  assert.equal(users.get("g1", users.all("g1")[0].id).forumThreadId, null);
});

test("posts made by people are never deleted", async () => {
  const users = createUserStore({ guildId: "g1" });
  const { guild, forum, deletions } = fakeWorld({
    active: [{ id: "t9", name: "A human's post", ownerId: "u9" }],
  });

  const report = await cleanUserForum({ forum, users, guild, botId: "bot", dryRun: false });

  assert.equal(report.targets, 0);
  assert.equal(report.skipped, 1);
  assert.equal(report.deleted, 0);
  assert.deepEqual(deletions, []);
});

test("the command asks for confirmation before deleting", async () => {
  const users = recordWithPost("t1");
  const { guild, forum } = fakeWorld({
    active: [
      { id: "t1", name: "Ada Lovelace (ada.l)" },
      { id: "t2", name: "Ghost One" },
    ],
  });

  const dry = interactionFor({}, guild);
  await runUserCommand(dry, { users, forum });
  assert.match(dry.replies[0].content, /\*\*1\*\* of \*\*2\*\* post\(s\)/);
  assert.match(dry.replies[0].content, /confirm: true/);
  assert.match(dry.replies[0].content, /Ghost One/);

  const real = interactionFor({ confirm: true }, guild);
  await runUserCommand(real, { users, forum });
  assert.match(real.replies[0].content, /Deleted \*\*1\*\* post\(s\)/);
  assert.equal(real.replies[0].flags, 64, "private by default");
});
