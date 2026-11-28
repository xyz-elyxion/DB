import test from "node:test";
import assert from "node:assert/strict";
import { USER_COMMANDS, runUserCommand } from "../src/lib/usercommands.js";
import { createUserStore } from "../src/lib/users.js";

const OPTIONS = {
  "first-name": "Ada",
  "last-name": "Lovelace",
  email: "ada@example.com",
  username: "ada.l",
  "date-of-birth": "1990-12-10",
  class: "10A",
  gender: "Female",
};

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

function interactionFor({ commandName, options = {}, can = true, userId = "mod" }) {
  const replies = [];
  const guild = { id: "g1", name: "Main" };

  return {
    commandName,
    guild,
    guildId: guild.id,
    user: { id: userId, username: "Moderator" },
    member: { id: userId, permissions: { has: () => can } },
    options: {
      getString(name, required) {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`missing ${name}`);
        return value;
      },
      getUser(name, required) {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`missing ${name}`);
        return value;
      },
      getBoolean(name) {
        return options[name] ?? null;
      },
      getInteger(name) {
        return options[name] ?? null;
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    replies,
  };
}

const store = () => createUserStore({ guildId: "g1" });

test("the database has create, view, edit and delete commands", () => {
  assert.deepEqual(
    USER_COMMANDS.map((command) => command.name).sort(),
    [
      "clean-user-forum",
      "create-user",
      "delete-user",
      "edit-user",
      "mass-add-users",
      "user-info",
    ],
  );
});

test("every command payload is valid for Discord", () => {
  const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

  for (const command of USER_COMMANDS) {
    const json = command.toJSON();
    assert.match(json.name, NAME);
    assert.ok(json.description.length <= 100, `${json.name} description is too long`);

    const names = (json.options ?? []).map((option) => option.name);
    assert.equal(
      new Set(names).size,
      names.length,
      `${json.name} repeats an option name: ${names.join(", ")}`,
    );

    for (const option of json.options ?? []) {
      assert.match(option.name, NAME, `${json.name} has an invalid option name`);
      assert.ok(
        option.description.length <= 100,
        `${json.name} ${option.name} has a description that is too long`,
      );
    }
  }
});

test("/create-user needs Manage Server and stores the record", async () => {
  const users = store();

  const denied = interactionFor({
    commandName: "create-user",
    can: false,
    options: { ...OPTIONS, member: { id: "u1" } },
  });
  await runUserCommand(denied, { users });
  assert.match(denied.replies[0].content, /Manage Server/);
  assert.equal(users.count("g1"), 0);

  const interaction = interactionFor({
    commandName: "create-user",
    options: { ...OPTIONS, member: { id: "u1" }, roles: "Student, Prefect" },
  });
  assert.equal(await runUserCommand(interaction, { users }), true);

  const record = users.get("g1", "u1");
  assert.equal(record.firstName, "Ada");
  assert.equal(record.createdBy, "mod");
  assert.deepEqual(record.roles, ["Student", "Prefect"]);
  assert.match(interaction.replies[0].content, /Created a record for <@u1>/);
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("/create-user explains a taken username", async () => {
  const users = store();
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const interaction = interactionFor({
    commandName: "create-user",
    options: { ...OPTIONS, member: { id: "u2" }, email: "other@example.com" },
  });
  await runUserCommand(interaction, { users });

  assert.match(interaction.replies[0].content, /username \*\*ada\.l\*\* is already used/);
});

test("/user-info shows every field and defaults to the caller", async () => {
  const users = store();
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const interaction = interactionFor({ commandName: "user-info", userId: "u1" });
  await runUserCommand(interaction, { users });

  const embed = interaction.replies[0].embeds[0].toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));

  assert.equal(embed.title, "👤 Ada Lovelace");
  assert.match(embed.description, /ada\.l/, "the database username under the title");
  assert.equal(fields.Email, "ada@example.com");
  assert.equal(fields.Reputation, "0 ⭐", "reputation is part of the record card");
  assert.match(fields["Date of birth"], /1990-12-10/);
  assert.equal(fields.Class, "10A");
  assert.equal(fields.Gender, "Female");
  assert.equal(fields.Discord, "<@u1>");
  assert.equal(fields.Roles, "`Student`, `Prefect`");
  assert.equal(interaction.replies[0].flags, 64, "private by default");
});

test("/user-info can look someone up by username and post publicly", async () => {
  const users = store();
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const interaction = interactionFor({
    commandName: "user-info",
    options: { username: "ADA.L", public: true },
  });
  await runUserCommand(interaction, { users });

  assert.match(interaction.replies[0].embeds[0].toJSON().title, /Ada Lovelace/);
  assert.equal(interaction.replies[0].flags, undefined, "public when asked");
});

test("reputation is set with /create-user and /edit-user", async () => {
  const users = store();

  const created = interactionFor({
    commandName: "create-user",
    options: { ...OPTIONS, member: { id: "u1" }, reputation: 4 },
  });
  await runUserCommand(created, { users });
  assert.equal(users.get("g1", "u1").reputation, 4);

  const edited = interactionFor({
    commandName: "edit-user",
    options: { member: { id: "u1" }, reputation: 0 },
  });
  await runUserCommand(edited, { users });
  assert.equal(users.get("g1", "u1").reputation, 0, "zero clears the points");
  assert.match(edited.replies[0].content, /Reputation/);
});

test("/user-info explains when there is no record", async () => {
  const users = store();

  const missing = interactionFor({
    commandName: "user-info",
    options: { member: { id: "u9" } },
  });
  await runUserCommand(missing, { users });
  assert.match(missing.replies[0].content, /doesn't have a record/);

  const self = interactionFor({ commandName: "user-info", userId: "u8" });
  await runUserCommand(self, { users });
  assert.match(self.replies[0].content, /don't have a record/);
});

test("/edit-user changes only the fields it is given", async () => {
  const users = store();
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const interaction = interactionFor({
    commandName: "edit-user",
    options: { member: { id: "u1" }, class: "11B", "clear-roles": true },
  });
  await runUserCommand(interaction, { users });

  const record = users.get("g1", "u1");
  assert.equal(record.class, "11B");
  assert.equal(record.email, "ada@example.com");
  assert.deepEqual(record.roles, []);
  assert.match(interaction.replies[0].content, /Class, Roles/);

  const empty = interactionFor({ commandName: "edit-user", options: { member: { id: "u1" } } });
  await runUserCommand(empty, { users });
  assert.match(empty.replies[0].content, /at least one field/);
});

test("/delete-user removes the record", async () => {
  const users = store();
  users.create({ guildId: "g1", userId: "u1", ...FIELDS });

  const interaction = interactionFor({ commandName: "delete-user", options: { member: { id: "u1" } } });
  await runUserCommand(interaction, { users });

  assert.equal(users.get("g1", "u1"), null);
  assert.match(interaction.replies[0].content, /Deleted the record of \*\*Ada Lovelace\*\*/);

  const again = interactionFor({ commandName: "delete-user", options: { member: { id: "u1" } } });
  await runUserCommand(again, { users });
  assert.match(again.replies[0].content, /doesn't have a record/);
});

test("/create-user works without a member and keeps the record unassigned", async () => {
  const users = store();

  const interaction = interactionFor({ commandName: "create-user", options: { ...OPTIONS } });
  await runUserCommand(interaction, { users });

  const [record] = users.all("g1");
  assert.equal(record.userId, null);
  assert.match(interaction.replies[0].content, /an unassigned record/);
  assert.match(interaction.replies[0].content, /\/user-info username:ada\.l/);

  const info = interactionFor({ commandName: "user-info", options: { username: "ada.l" } });
  await runUserCommand(info, { users });
  const fields = Object.fromEntries(
    info.replies[0].embeds[0].toJSON().fields.map((field) => [field.name, field.value]),
  );
  assert.equal(fields.Discord, "Not assigned");
});

test("unassigned records are edited and deleted by username", async () => {
  const users = store();
  users.create({ guildId: "g1", ...FIELDS });

  const edited = interactionFor({
    commandName: "edit-user",
    options: { "record-username": "ADA.L", class: "11B" },
  });
  await runUserCommand(edited, { users });
  assert.equal(users.findByUsername("g1", "ada.l").class, "11B");
  assert.equal(users.findByUsername("g1", "ada.l").userId, null);
  assert.match(edited.replies[0].content, /Updated \*\*Ada Lovelace\*\*/);

  const noTarget = interactionFor({ commandName: "edit-user", options: { class: "11B" } });
  await runUserCommand(noTarget, { users });
  assert.match(noTarget.replies[0].content, /Give a member or a database username/);

  const deleted = interactionFor({ commandName: "delete-user", options: { username: "ada.l" } });
  await runUserCommand(deleted, { users });
  assert.equal(users.count("g1"), 0);
  assert.match(deleted.replies[0].content, /\(unassigned\)/);
});

test("a slow command acknowledges at once and fills the reply in later", async () => {
  const users = store();
  const deferred = [];
  const edits = [];

  const interaction = {
    commandName: "create-user",
    guild: { id: "g1", name: "Main" },
    guildId: "g1",
    user: { id: "mod", username: "Moderator" },
    member: { id: "mod", permissions: { has: () => true } },
    options: {
      getString: (name) => OPTIONS[name] ?? null,
      getUser: (name) => (name === "member" ? { id: "u1" } : null),
      getBoolean: () => null,
    },
    async deferReply(payload) {
      deferred.push(payload ?? {});
    },
    async editReply(payload) {
      edits.push(payload);
    },
    async reply() {
      throw new Error("nothing should be replied directly once deferred");
    },
  };

  assert.equal(await runUserCommand(interaction, { users }), true);
  assert.deepEqual(deferred, [{ flags: 64 }], "acknowledged privately and immediately");
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Created a record for <@u1>/);
});

test("commands that are not user commands are left for the other handlers", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runUserCommand(interaction, { users: store() }), false);
  assert.equal(interaction.replies.length, 0);
});
