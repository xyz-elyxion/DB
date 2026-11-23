import "dotenv/config";

/**
 * Forgiving on purpose: dashboards hand us "true", "TRUE", "\"true\"", "yes",
 * "on" or "1", and a stray pair of quotes used to silently mean "off".
 */
export function readBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;

  const text = String(value)
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .toLowerCase();

  if (text === "") return fallback;
  if (["1", "t", "y", "true", "yes", "on", "enabled", "enable"].includes(text)) return true;
  if (["0", "f", "n", "false", "no", "off", "disabled", "disable"].includes(text)) {
    return false;
  }
  return fallback;
}

function readNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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
  // On by default: set ENABLE_MESSAGE_CONTENT=false to mirror only the structure.
  enableMessageContent: readBoolean(process.env.ENABLE_MESSAGE_CONTENT, true),
  messageContentEnv: process.env.ENABLE_MESSAGE_CONTENT ?? null,
  // Member join events need the privileged Server Members intent; they power
  // the one-person preview invites.
  enableMemberEvents: readBoolean(process.env.ENABLE_MEMBER_INTENTS, true),
  clientSecret: process.env.CLIENT_SECRET?.trim() || null,
  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID?.trim() || null,
  casesFile: process.env.CASES_FILE?.trim() || "data/moderation.json",
  invitesFile: process.env.INVITES_FILE?.trim() || "data/invites.json",
  joinBlocksFile: process.env.JOIN_BLOCKS_FILE?.trim() || "data/join-blocks.json",
  levelsFile: process.env.LEVELS_FILE?.trim() || "data/levels.json",
  xpMin: readNumber(process.env.XP_MIN_PER_MESSAGE, 15, { max: 10_000 }),
  xpMax: readNumber(process.env.XP_MAX_PER_MESSAGE, 25, { max: 10_000 }),
  xpCooldownSeconds: readNumber(process.env.XP_COOLDOWN_SECONDS, 60, { max: 86_400 }),
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
