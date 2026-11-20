import { REST, Routes } from "discord.js";
import { commands } from "../src/commands.js";
import { assertConfig, config } from "../src/config.js";

try {
  assertConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!config.clientId) {
  console.error("CLIENT_ID is missing. Add it to .env (Developer Portal -> General Information).");
  process.exit(1);
}

const rest = new REST().setToken(config.token);

try {
  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), {
      body: commands,
    });
    console.log(`Registered ${commands.length} command(s) in guild ${config.devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log(`Registered ${commands.length} global command(s).`);
  }
} catch (error) {
  console.error("Registration failed:", error.message);
  process.exit(1);
}
