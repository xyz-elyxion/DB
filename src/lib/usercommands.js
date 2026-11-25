import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { UserError, describeError } from "./errors.js";
import { retireUserPost, syncUserPost, userRecordEmbed } from "./userposts.js";

/** Creating, editing and deleting records is staff work. */
const GUARDS = {
  "create-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "edit-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "delete-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
};

/** Slash option name -> stored field, plus the label used in replies. */
const PROFILE_FIELDS = [
  ["first-name", "firstName", "First name"],
  ["last-name", "lastName", "Last name"],
  ["email", "email", "Email"],
  ["username", "username", "Username"],
  ["date-of-birth", "dateOfBirth", "Date of birth"],
  ["class", "class", "Class"],
  ["gender", "gender", "Gender"],
];

function addProfileOptions(command, { required = false } = {}) {
  return command
    .addStringOption((option) =>
      option
        .setName("first-name")
        .setDescription("Their first name")
        .setRequired(required)
        .setMaxLength(50),
    )
    .addStringOption((option) =>
      option
        .setName("last-name")
        .setDescription("Their last name")
        .setRequired(required)
        .setMaxLength(50),
    )
    .addStringOption((option) =>
      option
        .setName("email")
        .setDescription("Their email address (unique)")
        .setRequired(required)
        .setMaxLength(254),
    )
    .addStringOption((option) =>
      option
        .setName("username")
        .setDescription("Their username in the database (unique)")
        .setRequired(required)
        .setMaxLength(32),
    )
    .addStringOption((option) =>
      option
        .setName("date-of-birth")
        .setDescription("YYYY-MM-DD or DD/MM/YYYY")
        .setRequired(required)
        .setMaxLength(10),
    )
    .addStringOption((option) =>
      option
        .setName("class")
        .setDescription("Their class, year or group")
        .setRequired(required)
        .setMaxLength(40),
    )
    .addStringOption((option) =>
      option.setName("gender").setDescription("Their gender").setRequired(required).setMaxLength(32),
    );
}

export const USER_COMMANDS = [
  addProfileOptions(
    new SlashCommandBuilder()
      .setName("create-user")
      .setDescription("Add a member's name, email, birthday, class and roles to the database.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((option) =>
        option.setName("member").setDescription("The member this record belongs to").setRequired(true),
      ),
  ).addStringOption((option) =>
    option
      .setName("roles")
      .setDescription("Comma-separated roles, e.g. Student, Prefect")
      .setMaxLength(320),
  ),

  new SlashCommandBuilder()
    .setName("user-info")
    .setDescription("Show a member's record — yours by default.")
    .addUserOption((option) =>
      option.setName("member").setDescription("Whose record to show"),
    )
    .addStringOption((option) =>
      option.setName("username").setDescription("Look up by database username instead"),
    )
    .addBooleanOption((option) =>
      option.setName("public").setDescription("Show it to everyone instead of just you"),
    ),

  new SlashCommandBuilder()
    .setName("edit-user")
    .setDescription("Change fields on an existing record — give only what changes.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("member").setDescription("Whose record to change").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("first-name").setDescription("New first name").setMaxLength(50),
    )
    .addStringOption((option) =>
      option.setName("last-name").setDescription("New last name").setMaxLength(50),
    )
    .addStringOption((option) =>
      option.setName("email").setDescription("New email address").setMaxLength(254),
    )
    .addStringOption((option) =>
      option.setName("username").setDescription("New database username").setMaxLength(32),
    )
    .addStringOption((option) =>
      option.setName("date-of-birth").setDescription("YYYY-MM-DD or DD/MM/YYYY").setMaxLength(10),
    )
    .addStringOption((option) =>
      option.setName("class").setDescription("New class, year or group").setMaxLength(40),
    )
    .addStringOption((option) =>
      option.setName("gender").setDescription("New gender").setMaxLength(32),
    )
    .addStringOption((option) =>
      option.setName("roles").setDescription("Replace the roles list").setMaxLength(320),
    )
    .addBooleanOption((option) =>
      option.setName("clear-roles").setDescription("Remove every role from the record"),
    ),

  new SlashCommandBuilder()
    .setName("delete-user")
    .setDescription("Delete a member's record from the database.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("member").setDescription("Whose record to delete").setRequired(true),
    ),
];

const fieldLabel = (field) =>
  PROFILE_FIELDS.find(([, key]) => key === field)?.[2] ?? "Roles";

const HANDLERS = {
  async "create-user"({ guild, options, users, forum, moderator }) {
    const user = options.getUser("member", true);
    const record = users.create({
      guildId: guild.id,
      userId: user.id,
      createdBy: moderator?.id ?? null,
      firstName: options.getString("first-name", true),
      lastName: options.getString("last-name", true),
      email: options.getString("email", true),
      username: options.getString("username", true),
      dateOfBirth: options.getString("date-of-birth", true),
      class: options.getString("class", true),
      gender: options.getString("gender", true),
      roles: options.getString("roles") ?? undefined,
    });

    const threadId = await syncUserPost({ forum, users, guild, record });

    return {
      message:
        `🗂️ Created a record for <@${user.id}> — **${record.firstName} ${record.lastName}** ` +
        `(\`${record.username}\`).${record.roles.length ? ` Roles: ${record.roles.join(", ")}.` : ""}\n` +
        `Staff can check it with \`/user-info\` or change it with \`/edit-user\`.` +
        (threadId ? `\nPosted it in the user forum: <#${threadId}>.` : ""),
    };
  },

  async "user-info"({ interaction, guild, options, users }) {
    const member = options.getUser("member");
    const username = options.getString("username");

    let record = null;
    if (member) record = users.get(guild.id, member.id);
    else if (username) record = users.findByUsername(guild.id, username);
    else record = users.get(guild.id, interaction.user?.id);

    if (!record) {
      if (member) throw new UserError(`<@${member.id}> doesn't have a record yet.`);
      if (username) throw new UserError(`No record with the username **${username}**.`);
      throw new UserError("You don't have a record yet — staff can add one with `/create-user`.");
    }

    return {
      embeds: [userRecordEmbed(record, { authorName: member?.username ?? record.username })],
    };
  },

  async "edit-user"({ guild, options, users, forum }) {
    const user = options.getUser("member", true);
    const patch = {};

    for (const [optionName, field] of PROFILE_FIELDS) {
      const value = options.getString(optionName);
      if (value !== null && value !== undefined) patch[field] = value;
    }

    if (options.getBoolean("clear-roles")) patch.roles = "";
    else if (options.getString("roles")) patch.roles = options.getString("roles");

    if (Object.keys(patch).length === 0) {
      throw new UserError("Give at least one field to change.");
    }

    const { record, changed } = users.update({ guildId: guild.id, userId: user.id, ...patch });
    const threadId = await syncUserPost({ forum, users, guild, record });

    return {
      message:
        `✏️ Updated <@${user.id}>: ${changed.map(fieldLabel).join(", ")}.\n` +
        `**${record.firstName} ${record.lastName}** — \`${record.username}\`.` +
        (threadId ? `\nThe forum post is up to date: <#${threadId}>.` : ""),
    };
  },

  async "delete-user"({ guild, options, users, forum }) {
    const user = options.getUser("member", true);
    const removed = users.remove(guild.id, user.id);
    if (!removed) throw new UserError(`<@${user.id}> doesn't have a record.`);

    const threadId = await retireUserPost({ forum, guild, record: removed });

    return {
      message:
        `🗑️ Deleted the record of **${removed.firstName} ${removed.lastName}** (<@${user.id}>).` +
        (threadId ? `\nArchived its forum post: <#${threadId}>.` : ""),
    };
  },
};

function requirePermission(member, guard) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(guard.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${guard.label}** permission for that.`);
}

/**
 * Run one user-database command. Returns false when the command isn't ours, so
 * the other handlers can try next. Replies are private unless `public: true`.
 */
export async function runUserCommand(interaction, context = {}) {
  const name = interaction.commandName;
  const handler = HANDLERS[name];
  if (!handler) return false;

  const guild = interaction.guild;

  try {
    if (!guild) throw new UserError("User records only work inside a server.");
    if (!context.users) throw new UserError("The user database isn't running.");

    const guard = GUARDS[name];
    if (guard) requirePermission(interaction.member, guard);

    const result = await handler({
      interaction,
      guild,
      moderator: interaction.member,
      options: interaction.options,
      ...context,
    });

    const publicReply = interaction.options?.getBoolean?.("public") === true;
    const { message, ...rest } = result;

    await interaction.reply({
      ...(message ? { content: message } : {}),
      ...rest,
      ...(publicReply ? {} : { flags: MessageFlags.Ephemeral }),
    });
  } catch (error) {
    const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
    await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return true;
}
