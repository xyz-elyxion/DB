import "dotenv/config";

function readBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

const port =
  Number.parseInt(process.env.SERVER_PORT ?? process.env.PORT ?? "3000", 10) || 3000;

// PUBLIC_URLS holds every domain the bot answers on (comma or space separated).
// PUBLIC_URL is still accepted for a single domain.
const publicUrls = (
  process.env.PUBLIC_URLS?.trim() ||
  process.env.PUBLIC_URL?.trim() ||
  `http://localhost:${port}`
)
  .split(/[,\s]+/)
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const config = {
  token: process.env.DISCORD_TOKEN?.trim() ?? "",
  sourceId: process.env.SOURCE_GUILD_ID?.trim() || null,
  targetId: process.env.TARGET_GUILD_ID?.trim() || null,
  enableMessageContent: readBoolean(process.env.ENABLE_MESSAGE_CONTENT),
  clientSecret: process.env.CLIENT_SECRET?.trim() || null,
  port,
  publicUrls,
  joinPath: "/join/callback",
  redirectUris: publicUrls.map((url) => `${url}/join/callback`),
};

export function assertConfig() {
  const problems = [];

  if (!config.token) {
    problems.push(
      "DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token from the Discord Developer Portal.",
    );
  }
  if (!config.sourceId) problems.push("SOURCE_GUILD_ID is missing (the server to copy from).");
  if (!config.targetId) problems.push("TARGET_GUILD_ID is missing (the server to copy into).");
  if (config.sourceId && config.sourceId === config.targetId) {
    problems.push("SOURCE_GUILD_ID and TARGET_GUILD_ID have to be two different servers.");
  }

  if (problems.length === 1) throw new Error(problems[0]);
  if (problems.length > 1) {
    throw new Error(`Fix these in .env:\n- ${problems.join("\n- ")}`);
  }
}

export const REASON = "Server mirroring";
