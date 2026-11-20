import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { commands, handleAutocomplete, handleCommand, userFacingError } from "./commands.js";
import { assertConfig, config } from "./config.js";

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

async function registerCommands() {
  try {
    if (config.devGuildId) {
      await client.application.commands.set(commands, config.devGuildId);
      console.log(`Slash commands registered instantly in guild ${config.devGuildId}.`);
    } else {
      await client.application.commands.set(commands);
      console.log("Slash commands registered globally (Discord may take up to an hour to show them).");
    }
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag} — in ${readyClient.guilds.cache.size} server(s).`);
  registerCommands();
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

client.login(config.token).catch((error) => {
  console.error("Login failed:", error.message);
  process.exit(1);
});
