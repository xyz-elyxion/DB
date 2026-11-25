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
    ["create-user", "delete-user", "edit-user", "mass-add-users", "user-info"],
  );
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

  assert.equal(embed.title, "User record");
  assert.equal(fields["First name"], "Ada");
  assert.equal(fields["Last name"], "Lovelace");
  assert.equal(fields.Username, "ada.l");
  assert.equal(fields.Email, "ada@example.com");
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

  assert.equal(interaction.replies[0].embeds[0].toJSON().fields[0].value, "Ada");
  assert.equal(interaction.replies[0].flags, undefined, "public when asked");
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

test("commands that are not user commands are left for the other handlers", async () => {
  const interaction = interactionFor({ commandName: "rank" });
  assert.equal(await runUserCommand(interaction, { users: store() }), false);
  assert.equal(interaction.replies.length, 0);
});
