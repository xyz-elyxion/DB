import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { reputationCard, reputationLeaderboardCard } from "./embeds.js";
import { UserError, describeError } from "./errors.js";

/** Resetting reputation is staff work; giving and reading it is not. */
const GUARDS = {
  "rep-reset": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
};

export const REP_COMMANDS = [
  new SlashCommandBuilder()
    .setName("rep")
    .setDescription("Give a member a reputation point (one per member per day).")
    .addUserOption((option) =>
      option.setName("member").setDescription("Who to give it to").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Why — shown in their reputation history")
        .setMaxLength(200),
    ),

  new SlashCommandBuilder()
    .setName("rep-info")
    .setDescription("Show a member's reputation — yours by default.")
    .addUserOption((option) => option.setName("member").setDescription("Whose reputation to show"))
    .addBooleanOption((option) =>
      option.setName("public").setDescription("Show it to everyone instead of just you"),
    ),

  new SlashCommandBuilder()
    .setName("rep-leaderboard")
    .setDescription("The members with the most reputation.")
    .addIntegerOption((option) =>
      option.setName("page").setDescription("Which page (10 per page)").setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName("rep-reset")
    .setDescription("Wipe the reputation on a member's record.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("member").setDescription("Whose reputation to wipe").setRequired(true),
    )
    .addBooleanOption((option) =>
      option.setName("confirm").setDescription("Actually wipe it — leave this off to only check"),
    ),
];

/** Reputation lives on the record, so the member has to have one. */
function recordFor(users, guildId, userId) {
  const record = users.get(guildId, userId);
  if (!record) {
    throw new UserError(
      `<@${userId}> isn't in the database yet — staff can add their record with \`/create-user\`.`,
    );
  }
  return record;
}

const HANDLERS = {
  async rep({ guild, options, moderator, users }) {
    const user = options.getUser("member", true);
    const record = recordFor(users, guild.id, user.id);

    const result = users.addReputation({
      guildId: guild.id,
      recordId: record.id,
      fromId: moderator.id,
      amount: 1,
      note: options.getString("note"),
    });

    return {
      message:
        `⭐ Gave **+1** reputation to <@${user.id}> — they now have ` +
        `**${result.record.reputation.score}**.` +
        (result.record.reputation.entries[0]?.note
          ? `\nReason: ${result.record.reputation.entries[0].note}`
          : ""),
    };
  },

  async "rep-info"({ interaction, guild, options, users }) {
    const user = options.getUser("member") ?? interaction.user ?? { id: interaction.member?.id };
    const record = recordFor(users, guild.id, user.id);
    const board = users.topReputation(guild.id, { limit: Number.MAX_SAFE_INTEGER });

    return {
      embeds: [
        reputationCard({
          userId: user.id,
          score: record.reputation.score,
          rank: board.entries.find((entry) => entry.recordId === record.id)?.rank ?? null,
          total: board.total,
          entries: record.reputation.entries,
        }),
      ],
    };
  },

  async "rep-leaderboard"({ guild, options, users }) {
    const board = users.topReputation(guild.id, { page: options.getInteger("page") ?? 1 });
    if (board.total === 0) {
      return { message: "Nobody has reputation yet — give the first point with `/rep`." };
    }

    return {
      embeds: [
        reputationLeaderboardCard({
          entries: board.entries,
          page: board.page,
          pages: board.pages,
          total: board.total,
        }),
      ],
    };
  },

  async "rep-reset"({ guild, options, moderator, users }) {
    const user = options.getUser("member", true);
    const record = recordFor(users, guild.id, user.id);

    if (options.getBoolean("confirm") !== true) {
      return {
        message:
          `<@${user.id}> has **${record.reputation.score}** reputation point(s). ` +
          "Run it again with `confirm: true` to wipe them.",
      };
    }

    const before = users.resetReputation({
      guildId: guild.id,
      recordId: record.id,
      by: moderator?.id ?? null,
    });
    if (before === null) {
      return { message: `<@${user.id}> had no reputation to wipe.` };
    }

    return { message: `🧽 Cleared **${before}** reputation point(s) from <@${user.id}>.` };
  },
};

function requirePermission(member, guard) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(guard.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${guard.label}** permission for that.`);
}

/**
 * Run one reputation command. Returns false when the command isn't ours, so the
 * other handlers can try next. Replies are private unless `public: true`.
 */
export async function runRepCommand(interaction, context = {}) {
  const name = interaction.commandName;
  const handler = HANDLERS[name];
  if (!handler) return false;

  const guild = interaction.guild;

  try {
    if (!guild) throw new UserError("Reputation commands only work inside a server.");
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
