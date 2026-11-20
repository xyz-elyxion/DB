import "dotenv/config";

function readBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export const config = {
  token: process.env.DISCORD_TOKEN?.trim() ?? "",
  clientId: process.env.CLIENT_ID?.trim() || null,
  devGuildId: process.env.GUILD_ID?.trim() || null,
  enableMessageContent: readBoolean(process.env.ENABLE_MESSAGE_CONTENT),
};

export function assertConfig() {
  if (!config.token) {
    throw new Error(
      "DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token from the Discord Developer Portal.",
    );
  }
}

export const REASON = "Server replication";
