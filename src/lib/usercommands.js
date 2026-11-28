import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { UserError, describeError } from "./errors.js";
import { addMassRecords } from "./massusers.js";
import { cleanUserForum, retireUserPost, syncUserPost, userRecordEmbed } from "./userposts.js";

/** Creating, editing and deleting records is staff work. */
const GUARDS = {
  "create-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "edit-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "delete-user": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "mass-add-users": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "clean-user-forum": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
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
        .setDescription("YYYY-MM-DD or DD/MM/YYYY (optional)")
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
        option
          .setName("member")
          .setDescription("The member this record belongs to (leave blank to keep it unassigned)"),
      ),
  )
    .addStringOption((option) =>
      option
        .setName("roles")
        .setDescription("Comma-separated roles, e.g. Student, Prefect")
        .setMaxLength(320),
    )
    .addIntegerOption((option) =>
      option
        .setName("reputation")
        .setDescription("Reputation points to start them with (default 0)")
        .setMinValue(0)
        .setMaxValue(1_000_000),
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
      option.setName("member").setDescription("Whose record to change"),
    )
    .addStringOption((option) =>
      option
        .setName("record-username")
        .setDescription("…or the database username of the record to change")
        .setMaxLength(32),
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
    .addIntegerOption((option) =>
      option
        .setName("reputation")
        .setDescription("Set their reputation points (0 clears them)")
        .setMinValue(0)
        .setMaxValue(1_000_000),
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
      option.setName("member").setDescription("Whose record to delete"),
    )
    .addStringOption((option) =>
      option
        .setName("username")
        .setDescription("…or the record's database username (for unassigned records)")
        .setMaxLength(32),
    ),

  new SlashCommandBuilder()
    .setName("mass-add-users")
    .setDescription("Add many records at once from pasted lines or an attached file.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("records")
        .setDescription(
          "One per line: member | first | last | email | username | birthday | class | gender | roles",
        )
        .setMaxLength(4000),
    )
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription("Optional .txt or .csv with the same lines (up to 100 records)"),
    ),

  new SlashCommandBuilder()
    .setName("clean-user-forum")
    .setDescription("Delete posts in the user forum that no record points at.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Which posts to remove")
        .addChoices(
          { name: "Posts with no record (default)", value: "orphans" },
          { name: "Every post in the forum", value: "all" },
        ),
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Actually delete them — leave this off to only list what would go"),
    ),
];

const EXTRA_LABELS = { reputation: "Reputation", roles: "Roles" };
const fieldLabel = (field) =>
  PROFILE_FIELDS.find(([, key]) => key === field)?.[2] ?? EXTRA_LABELS[field] ?? field;

/** Find the record a command points at: by member, or by username when unassigned. */
function findRecord(users, guildId, { member = null, username = null } = {}) {
  if (member) {
    const record = users.get(guildId, member.id);
    if (!record) throw new UserError(`<@${member.id}> doesn't have a record yet.`);
    return record;
  }

  if (username) {
    const record = users.findByUsername(guildId, username);
    if (!record) throw new UserError(`No record with the username **${username}**.`);
    return record;
  }

  throw new UserError("Give a member or a database username.");
}

const HANDLERS = {
  async "create-user"({ guild, options, users, forum, moderator }) {
    const user = options.getUser("member");
    const record = users.create({
      guildId: guild.id,
      userId: user?.id ?? null,
      createdBy: moderator?.id ?? null,
      firstName: options.getString("first-name", true),
      lastName: options.getString("last-name", true),
      email: options.getString("email", true),
      username: options.getString("username", true),
      dateOfBirth: options.getString("date-of-birth") ?? undefined,
      class: options.getString("class", true),
      gender: options.getString("gender", true),
      roles: options.getString("roles") ?? undefined,
      reputation: options.getInteger?.("reputation") ?? 0,
    });

    const threadId = await syncUserPost({ forum, users, guild, record });

    return {
      message:
        `🗂️ Created ${user ? `a record for <@${user.id}>` : "an unassigned record"} — ` +
        `**${record.firstName} ${record.lastName}** (\`${record.username}\`).` +
        `${record.roles.length ? ` Roles: ${record.roles.join(", ")}.` : ""}\n` +
        (user
          ? ""
          : `It isn't linked to a member — find it with \`/user-info username:${record.username}\` ` +
            `or change it with \`/edit-user record-username:${record.username}\`.\n`) +
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
    const target = findRecord(users, guild.id, {
      member: options.getUser("member"),
      username: options.getString("record-username"),
    });
    const patch = {};

    for (const [optionName, field] of PROFILE_FIELDS) {
      const value = options.getString(optionName);
      if (value !== null && value !== undefined) patch[field] = value;
    }

    const reputation = options.getInteger?.("reputation");
    if (reputation !== null && reputation !== undefined) patch.reputation = reputation;

    if (options.getBoolean("clear-roles")) patch.roles = "";
    else if (options.getString("roles")) patch.roles = options.getString("roles");

    if (Object.keys(patch).length === 0) {
      throw new UserError("Give at least one field to change.");
    }

    const { record, changed } = users.update({
      guildId: guild.id,
      recordId: target.id,
      ...patch,
    });
    const threadId = await syncUserPost({ forum, users, guild, record });

    const label = record.userId
      ? `<@${record.userId}>`
      : `**${record.firstName} ${record.lastName}**`;
    return {
      message:
        `✏️ Updated ${label}: ${changed.map(fieldLabel).join(", ")}.\n` +
        `**${record.firstName} ${record.lastName}** — \`${record.username}\`.` +
        (threadId ? `\nThe forum post is up to date: <#${threadId}>.` : ""),
    };
  },

  async "delete-user"({ guild, options, users, forum }) {
    const target = findRecord(users, guild.id, {
      member: options.getUser("member"),
      username: options.getString("username"),
    });
    const removed = users.remove(guild.id, target.id);
    if (!removed) throw new UserError("That record is already gone.");

    const threadId = await retireUserPost({ forum, guild, record: removed });

    return {
      message:
        `🗑️ Deleted the record of **${removed.firstName} ${removed.lastName}** ` +
        `(${removed.userId ? `<@${removed.userId}>` : "unassigned"}).` +
        (threadId ? `\nArchived its forum post: <#${threadId}>.` : ""),
    };
  },

  async "mass-add-users"({
    guild,
    options,
    users,
    forum,
    moderator,
    respond,
    readAttachment = readAttachmentText,
  }) {
    const pasted = options.getString("records") ?? "";
    const file = options.getAttachment?.("file") ?? null;

    let text = pasted;
    if (file) text = [pasted, await readAttachment(file)].filter(Boolean).join("\n");
    if (!text.trim()) {
      throw new UserError(
        "Paste at least one line, or attach a .txt/.csv file. One record per line: " +
          "member | first name | last name | email | username | date of birth | class | gender | roles",
      );
    }

    const { added, problems } = addMassRecords({
      users,
      guildId: guild.id,
      text,
      createdBy: moderator?.id ?? null,
    });

    if (added.length > 0) {
      console.log(
        `[users] Imported ${added.length} record(s); ${users.count(guild.id)} stored in total.`,
      );
    }

    // The records are on disk now; the forum posts can take a while, so say so
    // before working through them instead of leaving the reply silent.
    if (added.length > 0 && forum?.channelId) {
      await respond?.({
        content:
          `🗂️ Added **${added.length}** record(s) to the database. ` +
          `Posting them in <#${forum.channelId}>…`,
      });
    }

    let posted = 0;
    for (const [index, record] of added.entries()) {
      if (await syncUserPost({ forum, users, guild, record })) posted += 1;

      // Discord throttles post creation; keep the reply moving every so often so
      // waiting on the limit doesn't look like a stall.
      const done = index + 1;
      if (forum?.channelId && done < added.length && done % 10 === 0) {
        await respond?.({
          content:
            `🗂️ Added **${added.length}** record(s). Posted **${done}** of them in ` +
            `<#${forum.channelId}>…`,
        });
      }
    }

    const lines = [`🗂️ Added **${added.length}** record(s) to the database.`];
    if (posted > 0) lines[0] += ` Posted ${posted} of them in <#${forum.channelId}>.`;
    if (problems.length > 0) {
      lines.push(`⚠️ Skipped **${problems.length}** line(s):`);
      for (const problem of problems) {
        lines.push(
          `• line ${problem.line}${problem.text ? ` (${problem.text})` : ""} — ${problem.reason}`,
        );
      }
    }

    return { message: shorten(lines.join("\n")) };
  },

  async "clean-user-forum"({ interaction, guild, options, users, forum }) {
    const mode = options.getString("mode") ?? "orphans";
    const confirm = options.getBoolean("confirm") === true;
    if (!forum?.channelId) throw new UserError("The user forum isn't configured.");

    const report = await cleanUserForum({
      forum,
      users,
      guild,
      botId: interaction.client?.user?.id ?? null,
      mode,
      dryRun: !confirm,
    });

    if (report.total === 0) {
      return { message: `There are no posts in <#${forum.channelId}>.` };
    }

    const lines = [];
    if (report.dryRun) {
      lines.push(
        `🔎 **${report.targets}** of **${report.total}** post(s) in <#${forum.channelId}> ` +
          (mode === "all" ? "would be deleted (every post)." : "have no record and can be deleted."),
      );
      if (report.sample.length > 0) lines.push(report.sample.map((name) => `• ${name}`).join("\n"));
      if (report.targets > 0) lines.push("Run it again with `confirm: true` to delete them.");
    } else {
      lines.push(
        `🧹 Deleted **${report.deleted}** post(s) from <#${forum.channelId}>` +
          `${report.failed.length ? `, ${report.failed.length} failed` : ""}.`,
      );
      if (report.failed.length > 0) {
        lines.push(report.failed.slice(0, 5).map((text) => `• ${text}`).join("\n"));
      }
    }

    if (report.skipped > 0) {
      lines.push(`Skipped **${report.skipped}** post(s) that weren't created by me.`);
    }

    return { message: shorten(lines.join("\n")) };
  },
};

/** Discord hosts uploads on its CDN; read the text of one attached list. */
async function readAttachmentText(attachment) {
  if (typeof attachment?.url !== "string") throw new UserError("That attachment can't be read.");

  let response;
  try {
    response = await fetch(attachment.url);
  } catch (error) {
    throw new UserError(`Could not download the file — ${describeError(error)}`);
  }
  if (!response.ok) throw new UserError(`Could not download the file (HTTP ${response.status}).`);

  const text = await response.text();
  if (text.length > 200_000) {
    throw new UserError("That file is too big — keep it under 200,000 characters.");
  }
  return text;
}

/** Discord rejects messages over 2000 characters, and a long list of skips adds up. */
function shorten(text, max = 1900) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 24).trimEnd()}\n… and more (list shortened)`;
}

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
  const publicReply = interaction.options?.getBoolean?.("public") === true;

  // Discord only gives an interaction three seconds, while creating forum
  // posts takes far longer. Acknowledge straight away, then fill the reply in.
  const deferred =
    typeof interaction.deferReply === "function" &&
    (await interaction
      .deferReply(publicReply ? {} : { flags: MessageFlags.Ephemeral })
      .then(() => true)
      .catch(() => false));

  const respond = async (payload) => {
    if (!deferred) return;
    await interaction.editReply(payload).catch(() => {});
  };

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
      respond,
      ...context,
    });

    const { message, ...rest } = result;
    const payload = { ...(message ? { content: message } : {}), ...rest };

    if (deferred) await interaction.editReply(payload).catch(() => {});
    else {
      await interaction
        .reply({ ...payload, ...(publicReply ? {} : { flags: MessageFlags.Ephemeral }) })
        .catch(() => {});
    }
  } catch (error) {
    const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;

    if (deferred) await interaction.editReply({ content: `⚠️ ${text}` }).catch(() => {});
    else {
      await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  return true;
}
