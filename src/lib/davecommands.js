import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { UserError, describeError } from "./errors.js";

/** Handing out Dave keys is manager work, in either of the two servers. */
const GUARD = { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" };

export const DAVE_COMMANDS = [
  new SlashCommandBuilder()
    .setName("dave-key")
    .setDescription("Create a one-time key so someone outside the servers can ask Dave.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName("user").setDescription("Who the key is for"),
    )
    .addStringOption((option) =>
      option
        .setName("user-id")
        .setDescription("…or their user ID, for someone who isn't in this server")
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Why they need it (optional)")
        .setMaxLength(100),
    ),
];

function requirePermission(member) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(GUARD.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${GUARD.label}** permission for that.`);
}

/** Run /dave-key. Returns false for any other command. */
export async function runDaveCommand(interaction, context = {}) {
  if (interaction.commandName !== "dave-key") return false;

  try {
    if (!interaction.guild) throw new UserError("Dave keys can only be made inside a server.");
    if (!context.keys) throw new UserError("Dave's key store isn't running.");

    requirePermission(interaction.member);

    // A user option can only pick people in this server, so a pasted ID covers
    // the outsiders keys are actually for.
    const selected = interaction.options.getUser("user");
    const typed = String(interaction.options.getString("user-id") ?? "").trim();
    const userId = selected?.id ?? typed;
    if (!userId) throw new UserError("Pick the user, or paste their user ID.");
    if (!/^\d{15,20}$/.test(userId)) {
      throw new UserError("A Discord user ID is 15–20 digits — right-click a name and Copy User ID.");
    }

    const record = context.keys.create({
      userId,
      createdBy: interaction.user?.id ?? interaction.member?.id ?? null,
      note: interaction.options.getString("note") ?? null,
    });

    await interaction.reply({
      content:
        `🔑 One-time key for <@${userId}>: \`${record.key}\`\n\n` +
        `They can ask Dave anywhere with:\n` +
        `\`Dave ${record.key} who is Jackson Zhu?\`\n\n` +
        "It works once, only for them, and stops working after the first answer.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
    await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return true;
}
