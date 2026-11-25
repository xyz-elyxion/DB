import test from "node:test";
import assert from "node:assert/strict";
import { createUserStore } from "../src/lib/users.js";
import { runUserCommand } from "../src/lib/usercommands.js";
import {
  createUserForum,
  forumThreadName,
  retireUserPost,
  syncExistingUserPosts,
  syncUserPost,
  userRecordEmbed,
} from "../src/lib/userposts.js";

const FIELDS = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  username: "ada.l",
  dateOfBirth: "1990-12-10",
  class: "10A",
  gender: "Female",
  roles: "Student, Prefect",
};

const OPTIONS = {
  "first-name": "Ada",
  "last-name": "Lovelace",
  email: "ada@example.com",
  username: "ada.l",
  "date-of-birth": "1990-12-10",
  class: "10A",
  gender: "Female",
};

/** A forum channel that hands back real-shaped threads with a starter message. */
function fakeWorld({ channelId = "forum", delayMs = 0 } = {}) {
  const posts = [];

  const channel = {
    id: channelId,
    threads: {
      async create(payload) {
        const message = {
          id: `m${posts.length + 1}`,
          embeds: payload.message.embeds,
          edits: [],
          async edit(edit) {
            this.edits.push(edit);
            if (edit.embeds) this.embeds = edit.embeds;
          },
        };
        const thread = {
          id: `t${posts.length + 1}`,
          name: payload.name,
          archived: false,
          locked: false,
          renames: [],
          message,
          async setName(name) {
            this.name = name;
            this.renames.push(name);
          },
          async fetchStarterMessage() {
            return this.message;
          },
          async setLocked(locked) {
            this.locked = locked;
          },
          async setArchived(archived) {
            this.archived = archived;
          },
        };
        posts.push({ payload, thread, message });
        return thread;
      },
    },
  };

  const guild = {
    id: "g1",
    name: "Main",
    channels: {
      cache: new Map([[channelId, channel]]),
      async fetch(id) {
        return posts.find((post) => post.thread.id === id)?.thread ?? null;
      },
    },
  };

  return { guild, posts, forum: createUserForum({ channelId, delayMs }) };
}

function interactionFor(commandName, options, guild = { id: "g1", name: "Main" }) {
  const replies = [];
  return {
    commandName,
    guild,
    guildId: "g1",
    user: { id: "mod", username: "Moderator" },
    member: { id: "mod", permissions: { has: () => true } },
    options: {
      getString(name) {
        return options[name] ?? null;
      },
      getUser(name) {
        return options[name] ?? null;
      },
      getBoolean(name) {
        return options[name] ?? null;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test("forum post titles carry the name and are shortened to fit", () => {
  assert.equal(
    forumThreadName({ firstName: "Ada", lastName: "Lovelace", username: "ada.l" }),
    "Ada Lovelace (ada.l)",
  );
  const long = forumThreadName({
    firstName: "A".repeat(60),
    lastName: "B".repeat(60),
    username: "x",
  });
  assert.equal(long.length, 100);
});

test("the record card shows every field and the roles section", () => {
  const embed = userRecordEmbed({
    userId: "u1",
    ...FIELDS,
    roles: ["Student", "Prefect"],
    updatedAt: "2026-01-02T00:00:00Z",
  }).toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

  assert.equal(fields["First name"], "Ada");
  assert.equal(fields.Email, "ada@example.com");
  assert.equal(fields.Roles, "`Student`, `Prefect`");
  assert.match(fields["Date of birth"], /1990-12-10/);
  assert.match(embed.footer.text, /2026-01-02/);
});

test("a record without a birthday or member says so on the card", () => {
  const embed = userRecordEmbed({
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    username: "ada.l",
    dateOfBirth: null,
    class: "10A",
    gender: "Female",
    roles: [],
    userId: null,
  }).toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

  assert.equal(fields["Date of birth"], "Not set");
  assert.equal(fields.Discord, "Not assigned");
});

test("creating a record opens a forum post and remembers it", async () => {
  const { guild, posts, forum } = fakeWorld();
  const users = createUserStore({ guildId: "g1" });
  const record = users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const threadId = await syncUserPost({ forum, users, guild, record });

  assert.equal(threadId, "t1");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread.name, "Ada Lovelace (ada.l)");
  assert.equal(posts[0].message.embeds[0].toJSON().fields[0].value, "Ada");
  assert.equal(users.get("g1", "u1").forumThreadId, "t1", "the thread id is stored");
});

test("new posts are spaced out so Discord's thread limit isn't hit", async () => {
  const { guild, posts, forum } = fakeWorld({ delayMs: 40 });
  const users = createUserStore({ guildId: "g1" });

  const started = Date.now();
  for (const [index, username] of ["one", "two", "three"].entries()) {
    const record = users.create({
      guildId: "g1",
      userId: `u${index}`,
      ...FIELDS,
      username,
      email: `${username}@example.com`,
    });
    await syncUserPost({ forum, users, guild, record });
  }
  const elapsed = Date.now() - started;

  assert.equal(posts.length, 3);
  assert.ok(elapsed >= 70, `two gaps of 40 ms should have been waited (took ${elapsed} ms)`);
});

test("editing a record rewrites the same post instead of making a new one", async () => {
  const { guild, posts, forum } = fakeWorld();
  const users = createUserStore({ guildId: "g1" });
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });
  await syncUserPost({ forum, users, guild, record: users.get("g1", "u1") });

  const { record } = users.update({
    guildId: "g1",
    recordId: "u1",
    username: "ada.new",
    class: "11B",
    roles: "",
  });
  await syncUserPost({ forum, users, guild, record });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread.renames[0], "Ada Lovelace (ada.new)");
  assert.equal(posts[0].message.edits.length, 1);

  const fields = Object.fromEntries(
    posts[0].message.embeds[0].toJSON().fields.map((field) => [field.name, field.value]),
  );
  assert.equal(fields.Class, "11B");
  assert.equal(fields.Roles, "None");
});

test("deleting a record marks the post and archives it", async () => {
  const { guild, posts, forum } = fakeWorld();
  const users = createUserStore({ guildId: "g1" });
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });
  const record = users.get("g1", "u1");
  await syncUserPost({ forum, users, guild, record });

  const removed = users.remove("g1", "u1");
  assert.equal(await retireUserPost({ forum, guild, record: removed }), "t1");

  assert.equal(posts[0].thread.archived, true);
  assert.equal(posts[0].thread.locked, true);
  assert.equal(posts[0].message.embeds[0].toJSON().title, "Record deleted");
});

test("the commands put records in the forum and keep it current", async () => {
  const { guild, posts, forum } = fakeWorld();
  const users = createUserStore({ guildId: "g1" });

  const created = interactionFor("create-user", {
    ...OPTIONS,
    member: { id: "u1" },
    roles: "Student, Prefect",
  });
  await runUserCommand(created, { users, forum, guild });
  assert.match(created.replies[0].content, /Posted it in the user forum: <#t1>/);
  assert.equal(posts.length, 1);

  const edited = interactionFor("edit-user", { member: { id: "u1" }, class: "11B" });
  await runUserCommand(edited, { users, forum, guild });
  assert.match(edited.replies[0].content, /forum post is up to date: <#t1>/);
  assert.equal(posts.length, 1, "the same post is edited");

  const deleted = interactionFor("delete-user", { member: { id: "u1" } });
  await runUserCommand(deleted, { users, forum, guild });
  assert.match(deleted.replies[0].content, /Archived its forum post: <#t1>/);
  assert.equal(posts[0].thread.archived, true);

  assert.ok(guild);
});

test("a missing forum never breaks a command", async () => {
  const users = createUserStore({ guildId: "g1" });
  const forum = createUserForum({ channelId: "1575034106188922963" });

  const interaction = interactionFor("create-user", { ...OPTIONS, member: { id: "u1" } });
  await runUserCommand(interaction, { users, forum });

  assert.equal(users.count("g1"), 1);
  assert.match(interaction.replies[0].content, /Created a record/);
  assert.doesNotMatch(interaction.replies[0].content, /user forum/);
});

test("records made before the forum existed are posted on startup", async () => {
  const { guild, posts, forum } = fakeWorld();
  const users = createUserStore({ guildId: "g1" });
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });
  users.create({ guildId: "g1", userId: "u2", ...FIELDS, username: "grace.h", email: "grace@example.com" });

  const posted = await syncExistingUserPosts({ forum, users, guild });

  assert.equal(posted, 2);
  assert.equal(posts.length, 2);
  assert.equal(await syncExistingUserPosts({ forum, users, guild }), 0, "already posted");
});
