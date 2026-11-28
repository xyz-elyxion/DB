import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
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
    .setDescription("Wipe a member's reputation.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("member").setDescription("Whose reputation to wipe").setRequired(true),
    )
    .addBooleanOption((option) =>
      option.setName("confirm").setDescription("Actually wipe it — leave this off to only check"),
    ),
];

const HANDLERS = {
  async rep({ guild, options, moderator, reputation }) {
    const user = options.getUser("member", true);
    const result = reputation.give({
      guildId: guild.id,
      userId: user.id,
      fromId: moderator.id,
      amount: 1,
      note: options.getString("note"),
    });

    return {
      message:
        `⭐ Gave **+1** reputation to <@${user.id}> — they now have ` +
        `**${result.entry.score}**.` +
        (result.entry.entries[0]?.note ? `\nReason: ${result.entry.entries[0].note}` : ""),
    };
  },

  async "rep-info"({ interaction, guild, options, reputation }) {
    const user = options.getUser("member") ?? interaction.user ?? { id: interaction.member?.id };
    const entry = reputation.get(guild.id, user.id);
    const board = reputation.top(guild.id, { limit: Number.MAX_SAFE_INTEGER });
    const rank = board.entries.find((row) => row.userId === user.id)?.rank ?? null;

    return {
      embeds: [
        reputationCard({
          userId: user.id,
          score: entry.score,
          rank,
          total: board.total,
          entries: entry.entries,
        }),
      ],
    };
  },

  async "rep-leaderboard"({ guild, options, reputation }) {
    const board = reputation.top(guild.id, { page: options.getInteger("page") ?? 1 });
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

  async "rep-reset"({ guild, options, moderator, reputation }) {
    const user = options.getUser("member", true);
    const confirm = options.getBoolean("confirm") === true;

    if (!confirm) {
      const entry = reputation.get(guild.id, user.id);
      return {
        message:
          `<@${user.id}> has **${entry.score}** reputation point(s). ` +
          "Run it again with `confirm: true` to wipe them.",
      };
    }

    const before = reputation.reset(guild.id, user.id, { by: moderator?.id ?? null });
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
    if (!context.reputation) throw new UserError("The reputation system isn't running.");

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
