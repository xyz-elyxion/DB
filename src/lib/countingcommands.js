import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { UserError, describeError } from "./errors.js";

const COLOR = 0x57f287;

/** Setup and resets need Manage Server; /counting-stats needs nothing. */
const GUARDS = {
  "counting-setup": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "counting-disable": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "counting-reset": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
};

const number = (value) => Number(value ?? 0).toLocaleString("en-US");

export const COUNTING_COMMANDS = [
  new SlashCommandBuilder()
    .setName("counting-setup")
    .setDescription("Pick the channel where people count together.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The counting channel")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  new SlashCommandBuilder()
    .setName("counting-disable")
    .setDescription("Stop counting in this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("counting-reset")
    .setDescription("Start the count over at 1, keeping the record.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("counting-stats").setDescription("How the count is going."),
];

const HANDLERS = {
  async "counting-setup"({ guild, options, counting }) {
    const channel = options.getChannel("channel", true);
    counting.setChannel(guild.id, channel.id);

    return {
      message:
        `🔢 <#${channel.id}> is the counting channel, and the next number is **1**.\n\n` +
        "Everyone takes turns: each message must be the next number, posted by someone " +
        "other than the last counter. A wrong number or two in a row starts again at 1.",
    };
  },

  async "counting-disable"({ guild, counting }) {
    const settings = counting.settings(guild.id);
    counting.disable(guild.id);

    return {
      message: settings.count
        ? `⏹️ Counting is off — the chain stopped at **${number(settings.count)}** ` +
          `(best: **${number(settings.record)}**).`
        : "⏹️ Counting is off.",
    };
  },

  async "counting-reset"({ guild, counting }) {
    const settings = counting.reset(guild.id);
    return {
      message:
        `🔄 Started over — the next number is **1**. ` +
        `Best so far: **${number(settings.record)}**.`,
    };
  },

  async "counting-stats"({ guild, counting }) {
    const settings = counting.settings(guild.id);
    if (!settings.enabled) {
      return { message: "Counting isn't set up yet — a manager can run `/counting-setup`." };
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle("Counting")
      .addFields(
        { name: "Channel", value: `<#${settings.channelId}>`, inline: true },
        { name: "Current", value: number(settings.count), inline: true },
        { name: "Next number", value: number(settings.next), inline: true },
        { name: "Best", value: number(settings.record), inline: true },
        {
          name: "Last counter",
          value: settings.lastUserId ? `<@${settings.lastUserId}>` : "Nobody yet",
          inline: true,
        },
      )
      .setFooter({ text: "One number per message, never the same person twice in a row" });

    return { embeds: [embed] };
  },
};

function requirePermission(member, guard) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(guard.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${guard.label}** permission for that.`);
}

/**
 * Run one counting command. Returns false when the command isn't ours, so the
 * other handlers can try next. Replies are always private.
 */
export async function runCountingCommand(interaction, context = {}) {
  const name = interaction.commandName;
  const handler = HANDLERS[name];
  if (!handler) return false;

  const guild = interaction.guild;
  const { counting } = context;

  try {
    if (!guild) throw new UserError("Counting commands only work inside a server.");
    if (!counting) throw new UserError("The counting system isn't running.");

    const guard = GUARDS[name];
    if (guard) requirePermission(interaction.member, guard);

    const result = await handler({
      guild,
      options: interaction.options,
      counting,
      ...context,
    });

    const { message, ...rest } = result;
    await interaction.reply({
      ...(message ? { content: message } : {}),
      ...rest,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
    await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return true;
}
