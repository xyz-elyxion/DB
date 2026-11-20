import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { handleAutocomplete, handleCommand, userFacingError } from "./commands.js";
import { assertConfig, config } from "./config.js";
import { registerCommands } from "./register.js";
import { mirrorMessage } from "./lib/mirror.js";

try {
  assertConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const intents = [GatewayIntentBits.Guilds];
if (config.enableMessageContent) {
  intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

const client = new Client({ intents });

// Live mirroring: repost new messages from one server into the matching channel
// of the other, using SOURCE_GUILD_ID + TARGET_GUILD_ID.
const mirroring = Boolean(config.mirror.sourceId && config.mirror.targetId);
const mirrorEnabled = mirroring && config.enableMessageContent;

if (mirroring && !config.enableMessageContent) {
  console.warn(
    "Live mirroring is configured, but ENABLE_MESSAGE_CONTENT is off — message text can't be read, so nothing will be mirrored.",
  );
}

const mirrorHooks = new Map();

async function handleMirroredMessage(message) {
  if (!mirrorEnabled) return;
  if (message.guildId !== config.mirror.sourceId) return;

  const target =
    client.guilds.cache.get(config.mirror.targetId) ??
    (await client.guilds.fetch(config.mirror.targetId).catch(() => null));
  if (!target) {
    console.warn(`I'm not in the mirror target server (${config.mirror.targetId}).`);
    return;
  }

  const result = await mirrorMessage({
    message,
    targetGuild: target,
    client,
    hooks: mirrorHooks,
  });

  if (result.reason === "no matching channel") {
    console.warn(
      `No #${message.channel?.name} in the target server, so that message wasn't mirrored.`,
    );
  }
}

let commandsRegistered = false;

async function syncCommands() {
  try {
    const { count, scope } = await registerCommands();
    commandsRegistered = true;
    console.log(`Registered ${count} slash command(s) ${scope}.`);
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} — in ${readyClient.guilds.cache.size} server(s).`);
  // Normally already done before login; retry once the gateway is up if it failed.
  if (!commandsRegistered) await syncCommands();
  if (mirrorEnabled) {
    console.log(
      `Mirroring new messages from ${config.mirror.sourceId} into ${config.mirror.targetId}.`,
    );
  }
});

client.on(Events.MessageCreate, (message) => {
  handleMirroredMessage(message).catch((error) => {
    console.error(`Couldn't mirror a message from #${message.channel?.name}:`, error.message);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    }
  } catch (error) {
    const message = userFacingError(error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `⚠️ ${message}`, embeds: [] });
      } else if (interaction.isRepliable()) {
        await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction may have expired; nothing else to do.
    }
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("SIGINT", () => {
  client.destroy();
  process.exit(0);
});

// `npm start` registers the slash commands itself; no separate `npm run register` step.
await syncCommands();

client.login(config.token).catch((error) => {
  console.error("Login failed:", error.message);
  process.exit(1);
});
