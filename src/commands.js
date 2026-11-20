import {
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { REASON } from "./config.js";
import { applyPlan } from "./lib/builder.js";
import { UserError } from "./lib/errors.js";
import { planReplication } from "./lib/planner.js";
import { renderPreview, renderProgress, renderResult } from "./lib/render.js";
import { snapshotGuild } from "./lib/snapshot.js";

const activeTargets = new Set();

const sourceOption = (option) =>
  option
    .setName("source")
    .setDescription("Server to copy from")
    .setRequired(true)
    .setAutocomplete(true);

const targetOption = (option) =>
  option
    .setName("target")
    .setDescription("Server to replicate into (the 'preview' server)")
    .setRequired(true)
    .setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder()
    .setName("preview")
    .setDescription("Show exactly what /clone would create in another server, without changing anything")
    .addStringOption(sourceOption)
    .addStringOption(targetOption),
  new SlashCommandBuilder()
    .setName("clone")
    .setDescription("Replicate a server's roles, channels, permissions and settings into another server")
    .addStringOption(sourceOption)
    .addStringOption(targetOption)
    .addIntegerOption((option) =>
      option
        .setName("messages")
        .setDescription("Recent messages to replay per text channel (0 = structure only)")
        .setMinValue(0)
        .setMaxValue(100),
    )
    .addBooleanOption((option) =>
      option
        .setName("settings")
        .setDescription("Also copy the server name, icon and other settings (default: true)"),
    ),
].map((command) => command.toJSON());

async function fetchGuild(client, id) {
  const cached = client.guilds.cache.get(id);
  if (cached) return cached;
  try {
    return await client.guilds.fetch(id);
  } catch {
    return null;
  }
}

async function loadGuilds(interaction) {
  const sourceId = interaction.options.getString("source", true).trim();
  const targetId = interaction.options.getString("target", true).trim();

  if (!/^\d{15,22}$/.test(sourceId) || !/^\d{15,22}$/.test(targetId)) {
    throw new UserError("Pick two servers from the autocomplete list (or paste their IDs).");
  }
  if (sourceId === targetId) {
    throw new UserError("The source and target servers have to be different.");
  }

  const source = await fetchGuild(interaction.client, sourceId);
  if (!source) {
    throw new UserError(`I'm not in the source server (\`${sourceId}\`). Invite me there first.`);
  }

  const target = await fetchGuild(interaction.client, targetId);
  if (!target) {
    throw new UserError(`I'm not in the target server (\`${targetId}\`). Invite me there first.`);
  }

  if (target.id !== interaction.guildId) {
    throw new UserError(
      "Run this command **inside the target server** so I know you're allowed to change it.",
    );
  }

  return { source, target };
}

async function assertCanClone(target) {
  const me = target.members.me ?? (await target.members.fetch(target.client.user.id).catch(() => null));
  if (!me) throw new UserError("I couldn't check my permissions in the target server.");

  if (me.permissions.has(PermissionFlagsBits.Administrator)) return me;

  const missing = [];
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) missing.push("Manage Roles");
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) missing.push("Manage Channels");
  if (missing.length) {
    throw new UserError(
      `I need **${missing.join("** and **")}** in this server. Grant them to my role (or give me Administrator) and try again.`,
    );
  }
  return me;
}

async function handlePreview(interaction) {
  await interaction.deferReply();

  const { source, target } = await loadGuilds(interaction);
  const plan = planReplication(snapshotGuild(source), snapshotGuild(target));

  if (
    !plan.stats.roles.create &&
    !plan.stats.channels.create &&
    !plan.stats.categories.create &&
    !plan.stats.emojis.create &&
    !plan.settings.length
  ) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("Already a match")
      .setDescription(
        `**${target.name}** already has the roles and channels of **${source.name}**. Nothing to replicate.`,
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await interaction.editReply({ embeds: [renderPreview(plan)] });
}

async function handleClone(interaction) {
  await interaction.deferReply();

  const messages = interaction.options.getInteger("messages") ?? 0;
  const copySettings = interaction.options.getBoolean("settings") ?? true;

  if (messages > 0 && !interaction.client.options.intents.has(GatewayIntentBits.MessageContent)) {
    throw new UserError(
      "Copying messages needs the **Message Content** privileged intent. Enable it in the Developer Portal, set `ENABLE_MESSAGE_CONTENT=true` in `.env`, and restart me — or run `/clone` with `messages: 0`.",
    );
  }

  const { source, target } = await loadGuilds(interaction);
  await assertCanClone(target);

  if (activeTargets.has(target.id)) {
    throw new UserError(`A replication into **${target.name}** is already running. Let it finish first.`);
  }
  activeTargets.add(target.id);

  const startedAt = Date.now();
  try {
    const plan = planReplication(snapshotGuild(source), snapshotGuild(target), {
      maxMessages: messages,
      copySettings,
    });

    await interaction.editReply({ embeds: [renderPreview(plan)] });

    let lastEdit = 0;
    const report = await applyPlan({
      plan,
      sourceGuild: source,
      targetGuild: target,
      options: { reason: REASON },
      onProgress: ({ done, total, label }) => {
        if (done !== total && Date.now() - lastEdit < 2000) return;
        lastEdit = Date.now();
        interaction.editReply({ embeds: [renderProgress(done, total, label)] }).catch(() => {});
      },
    });

    await interaction.editReply({
      embeds: [renderResult(plan, report, { durationMs: Date.now() - startedAt })],
    });
  } finally {
    activeTargets.delete(target.id);
  }
}

export async function handleCommand(interaction) {
  if (interaction.commandName === "preview") return handlePreview(interaction);
  if (interaction.commandName === "clone") return handleClone(interaction);
}

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "").toLowerCase();

  const choices = [...interaction.client.guilds.cache.values()]
    .filter(
      (guild) => guild.name.toLowerCase().includes(query) || guild.id.includes(query),
    )
    .slice(0, 25)
    .map((guild) => ({
      name: `${guild.name} (${guild.id})`.slice(0, 100),
      value: guild.id,
    }));

  await interaction.respond(choices);
}

export function userFacingError(error) {
  if (error instanceof UserError) return error.message;
  console.error(error);
  return "Something went wrong while replicating. Check the bot's logs and try again.";
}

