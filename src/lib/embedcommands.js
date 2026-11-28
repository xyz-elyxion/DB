import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { DEFAULT_SCAN_LIMIT, migrateEmbeds } from "./embedmigrate.js";
import { UserError, describeError } from "./errors.js";

export const EMBED_COMMANDS = [
  new SlashCommandBuilder()
    .setName("migrate-embeds")
    .setDescription("Rewrite every embed the bot posted before the current style.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((option) =>
      option.setName("dry-run").setDescription("Only count what would change"),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription(`Messages to scan per channel (default ${DEFAULT_SCAN_LIMIT})`)
        .setMinValue(10)
        .setMaxValue(500),
    ),
];

function describeKinds(kinds) {
  const entries = Object.entries(kinds).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return "";
  return entries.map(([kind, count]) => `${count} ${kind}`).join(", ");
}

const HANDLERS = {
  async "migrate-embeds"({ options, guilds, botId, respond }) {
    if (guilds.length === 0) throw new UserError("I can't see the servers to migrate.");

    const dryRun = options.getBoolean("dry-run") === true;
    const limit = options.getInteger("limit") ?? DEFAULT_SCAN_LIMIT;

    // A full scan edits a lot of messages, so say what is happening first.
    await respond?.({
      content:
        `🎨 Scanning **${guilds.length}** server(s) for old embeds` +
        `${dryRun ? " (dry run — nothing will change)" : ""}. This can take a while…`,
    });

    const report = await migrateEmbeds({ guilds, botId, limit, dryRun });

    const lines = [
      dryRun
        ? `🔎 **${report.converted}** embed(s) in **${report.messagesScanned}** message(s) ` +
          `would be rewritten.`
        : `✅ Rewrote **${report.converted}** embed(s) in **${report.updated}** message(s).`,
      `Scanned ${report.messagesScanned} message(s) across ${report.channelsScanned} channel(s) ` +
        `and ${report.threadsScanned} forum post(s) in ` +
        `${report.guilds.map((guild) => guild.name).join(", ") || "no server"}.`,
    ];

    const kinds = describeKinds(report.kinds);
    if (kinds) lines.push(`By kind: ${kinds}.`);
    if (report.alreadyCurrent > 0) {
      lines.push(`⏭️ ${report.alreadyCurrent} embed(s) were already in the new style.`);
    }
    if (report.unknown > 0) {
      lines.push(`🤷 ${report.unknown} embed(s) weren't mine and were left alone.`);
    }
    if (report.failed.length > 0) {
      lines.push(`⚠️ ${report.failed.length} failed:`);
      for (const failure of report.failed.slice(0, 5)) lines.push(`• ${failure}`);
      if (report.failed.length > 5) lines.push("• …and more (see the bot log).");
    }

    return { message: lines.join("\n").slice(0, 1900) };
  },
};

/** Run /migrate-embeds. Returns false when the command isn't ours. */
export async function runEmbedCommand(interaction, context = {}) {
  const handler = HANDLERS[interaction.commandName];
  if (!handler) return false;

  const deferred =
    typeof interaction.deferReply === "function" &&
    (await interaction
      .deferReply({ flags: MessageFlags.Ephemeral })
      .then(() => true)
      .catch(() => false));

  const respond = async (payload) => {
    if (!deferred) return;
    await interaction.editReply(payload).catch(() => {});
  };

  try {
    if (!interaction.guild) throw new UserError("Embed migration only works inside a server.");

    const member = interaction.member;
    const allowed =
      typeof member?.permissions?.has === "function"
        ? member.permissions.has(PermissionFlagsBits.ManageGuild)
        : Boolean(member?.permissions);
    if (!allowed) throw new UserError("You need the **Manage Server** permission for that.");

    const { message } = await handler({
      interaction,
      options: interaction.options,
      guilds: (context.guilds ?? []).filter(Boolean),
      botId: context.botId ?? interaction.client?.user?.id ?? null,
      respond,
    });

    if (!deferred) {
      await interaction
        .reply({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else {
      await interaction.editReply({ content: message }).catch(() => {});
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
