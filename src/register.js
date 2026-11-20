import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config } from "./config.js";

const rest = () => new REST().setToken(config.token);

// A bot token identifies its own application, so the application ID is looked up
// instead of making people copy CLIENT_ID into .env. CLIENT_ID is only a fallback
// for the rare case where that lookup fails.
async function resolveApplicationId() {
  try {
    const application = await rest().get(Routes.oauth2CurrentApplication());
    return application.id;
  } catch (error) {
    if (config.clientId) return config.clientId;
    throw error;
  }
}

/**
 * Register (`PUT`) the slash commands, replacing whatever was there before.
 * Returns the command count and a description of where they landed.
 */
export async function registerCommands() {
  const applicationId = await resolveApplicationId();

  if (config.devGuildId) {
    await rest().put(Routes.applicationGuildCommands(applicationId, config.devGuildId), {
      body: commands,
    });
    return {
      count: commands.length,
      scope: `in guild ${config.devGuildId} (available immediately)`,
    };
  }

  await rest().put(Routes.applicationCommands(applicationId), { body: commands });
  return {
    count: commands.length,
    scope: "globally (Discord may take up to an hour to show them the first time)",
  };
}
