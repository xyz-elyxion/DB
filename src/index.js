import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { handleAutocomplete, handleCommand, userFacingError } from "./commands.js";
import { assertConfig, config } from "./config.js";
import { registerCommands } from "./register.js";

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
