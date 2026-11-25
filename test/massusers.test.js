import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MASS_RECORDS, addMassRecords, parseMassRecords } from "../src/lib/massusers.js";
import { createUserStore } from "../src/lib/users.js";
import { USER_COMMANDS, runUserCommand } from "../src/lib/usercommands.js";
import { createUserForum } from "../src/lib/userposts.js";

const ADA = "<@111111111111111111> | Ada | Lovelace | ada@example.com | ada.l | 1990-12-10 | 10A | Female | Student, Prefect";
const GRACE = "<@222222222222222222> | Grace | Hopper | grace@example.com | grace.h | 1906-12-09 | 11B | Female";

function fakeForum() {
  const posts = [];
  const thread = (payload) => {
    const message = {
      embeds: payload.message.embeds,
      async edit(edit) {
        if (edit.embeds) this.embeds = edit.embeds;
      },
    };
    return {
      id: `t${posts.length + 1}`,
      name: payload.name,
      archived: false,
      async setName(name) {
        this.name = name;
      },
      async fetchStarterMessage() {
        return message;
      },
      async setLocked() {},
      async setArchived(archived) {
        this.archived = archived;
      },
      message,
    };
  };

  const channel = {
    id: "forum",
    threads: {
      async create(payload) {
        const created = thread(payload);
        posts.push({ payload, thread: created });
        return created;
      },
    },
  };

  const guild = {
    id: "g1",
    name: "Main",
    channels: {
      cache: new Map([["forum", channel]]),
      async fetch(id) {
        return posts.find((post) => post.thread.id === id)?.thread ?? null;
      },
    },
  };

  return { guild, posts, forum: createUserForum({ channelId: "forum" }) };
}

function interactionFor(options, guild) {
  const replies = [];
  return {
    commandName: "mass-add-users",
    guild: guild ?? { id: "g1", name: "Main" },
    guildId: "g1",
    user: { id: "mod", username: "Moderator" },
    member: { id: "mod", permissions: { has: () => true } },
    options: {
      getString(name) {
        return options[name] ?? null;
      },
      getBoolean(name) {
        return options[name] ?? null;
      },
      getUser(name) {
        return options[name] ?? null;
      },
      getAttachment(name) {
        return options[name] ?? null;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

test("the mass add command is registered with the user database", () => {
  assert.ok(USER_COMMANDS.some((command) => command.name === "mass-add-users"));
});

test("lines are read with pipes, tabs, mentions and comments", () => {
  const text = [
    "# member | first | last | email | username | birthday | class | gender | roles",
    ADA,
    "<@!222222222222222222>\tGrace\tHopper\tgrace@example.com\tgrace.h\t1906-12-09\t11B\tFemale",
    "// a comment",
    "",
    "333333333333333333 ; Alan ; Turing ; alan@example.com ; alan.t ; 1912-06-23 ; 12C ; Male ; Prefect",
  ].join("\n");

  const { records, problems } = parseMassRecords(text);
  assert.equal(problems.length, 0);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => [record.userId, record.firstName, record.username]),
    [
      ["111111111111111111", "Ada", "ada.l"],
      ["222222222222222222", "Grace", "grace.h"],
      ["333333333333333333", "Alan", "alan.t"],
    ],
  );
  assert.equal(records[2].roles, "Prefect");
  assert.equal(records[0].roles, "Student, Prefect");
});

test("bad lines are reported without dropping the good ones", () => {
  const { records, problems } = parseMassRecords(
    [
      "not-a-member | Ada | Lovelace | ada@example.com | ada.l | 1990-12-10 | 10A | Female",
      "111111111111111111 | Ada | Lovelace | ada@example.com",
      "111111111111111111 | Ada | Lovelace | ada@example.com | ada.l | 1990-12-10 | 10A | Female | a | b",
      "no separators here",
    ].join("\n"),
  );

  assert.equal(records.length, 0);
  assert.deepEqual(
    problems.map((problem) => problem.line),
    [1, 2, 3, 4],
  );
  assert.match(problems[0].reason, /isn't a member/);
  assert.match(problems[1].reason, /8 or 9 fields/);
  assert.match(problems[2].reason, /comma-separated field/);
  assert.match(problems[3].reason, /separate the fields/);
});

test("every valid line becomes a record, failures keep their line number", () => {
  const users = createUserStore({ guildId: "g1" });
  const { added, problems } = addMassRecords({
    users,
    guildId: "g1",
    createdBy: "mod",
    text: [
      ADA,
      "<@444444444444444444> | Ada | Again | ada.again@example.com | ada.l | 1991-01-01 | 10A | Female",
      "<@555555555555555555> | Bad | Email | nope@ | bad@example.com | 1992-01-01 | 10A | Female",
      GRACE,
    ].join("\n"),
  });

  assert.equal(added.length, 2);
  assert.equal(problems.length, 2);
  assert.deepEqual(
    problems.map((problem) => problem.line),
    [2, 3],
  );
  assert.match(problems[0].reason, /username \*\*ada\.l\*\* is already used/);
  assert.match(problems[1].reason, /email/i);
  assert.equal(users.count("g1"), 2);
  assert.equal(users.get("g1", "111111111111111111").createdBy, "mod");
});

test("too many records at once are refused rather than half-added", () => {
  const users = createUserStore({ guildId: "g1" });
  const line = (index) =>
    `<@${String(100000000000000000 + index)}> | First${index} | Last${index} | person${index}@example.com | person${index} | 1990-01-01 | 10A | Female`;

  const text = Array.from({ length: MAX_MASS_RECORDS + 1 }, (_, index) => line(index)).join("\n");

  assert.throws(() => addMassRecords({ users, guildId: "g1", text }), /at most 100/);
  assert.equal(users.count("g1"), 0);
});

test("nothing to add is explained with the format", () => {
  const users = createUserStore({ guildId: "g1" });
  assert.throws(
    () => addMassRecords({ users, guildId: "g1", text: "# only a comment\n\n" }),
    /member \| first name/,
  );
});

test("the command adds the lines and posts each one in the forum", async () => {
  const { guild, posts, forum } = fakeForum();
  const users = createUserStore({ guildId: "g1" });

  const interaction = interactionFor({ records: `${ADA}\n${GRACE}` }, guild);
  await runUserCommand(interaction, { users, forum });

  assert.equal(users.count("g1"), 2);
  assert.equal(posts.length, 2);
  assert.match(interaction.replies[0].content, /Added \*\*2\*\* record/);
  assert.match(interaction.replies[0].content, /Posted 2 of them in <#forum>/);
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("the command can read an attached file and mix it with pasted lines", async () => {
  const { guild, posts, forum } = fakeForum();
  const users = createUserStore({ guildId: "g1" });

  const interaction = interactionFor(
    { records: ADA, file: { id: "a1", name: "members.txt", url: "https://cdn.example/members.txt" } },
    guild,
  );
  const read = [];
  await runUserCommand(interaction, {
    users,
    forum,
    readAttachment: async (attachment) => {
      read.push(attachment.name);
      return GRACE;
    },
  });

  assert.deepEqual(read, ["members.txt"]);
  assert.equal(users.count("g1"), 2);
  assert.equal(posts.length, 2);
});

test("the command reports skipped lines and still adds the rest", async () => {
  const { guild, posts, forum } = fakeForum();
  const users = createUserStore({ guildId: "g1" });
  users.create({
    guildId: "g1",
    userId: "111111111111111111",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    username: "ada.l",
    dateOfBirth: "1990-12-10",
    class: "10A",
    gender: "Female",
  });

  const interaction = interactionFor({ records: `${ADA}\n${GRACE}` }, guild);
  await runUserCommand(interaction, { users, forum });

  const reply = interaction.replies[0].content;
  assert.match(reply, /Added \*\*1\*\* record/);
  assert.match(reply, /Skipped \*\*1\*\* line/);
  assert.match(reply, /line 1 .*already has a record/);
  assert.equal(posts.length, 1);
});

test("the command needs at least one line", async () => {
  const { guild, forum } = fakeForum();
  const users = createUserStore({ guildId: "g1" });

  const interaction = interactionFor({}, guild);
  await runUserCommand(interaction, { users, forum });

  assert.match(interaction.replies[0].content, /Paste at least one line/);
  assert.equal(users.count("g1"), 0);
});
