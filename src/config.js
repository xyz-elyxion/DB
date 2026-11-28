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

/**
 * The forum channel that holds one post per user record. Unset means the default
 * forum; "off" turns the forum posts off and keeps records in the database only.
 */
const DEFAULT_USER_FORUM_ID = "1575034106188922963";
const OFF_VALUES = /^(off|none|no|false|0|-)$/i;

function readChannelId(value, fallback) {
  const text = value?.trim();
  if (!text) return fallback;
  return OFF_VALUES.test(text) ? null : text;
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
  countingFile: process.env.COUNTING_FILE?.trim() || "data/counting.json",
  usersFile: process.env.USERS_FILE?.trim() || "data/users.json",
  // Reputation for the members in that database, given with /rep.
  reputationFile: process.env.REPUTATION_FILE?.trim() || "data/reputation.json",
  usersForumId: readChannelId(process.env.USERS_FORUM_CHANNEL_ID, DEFAULT_USER_FORUM_ID),
  // Dave, the student-database assistant. Every answer he gives is written by an
  // OpenAI-compatible chat model; without a key he says he isn't connected
  // instead of inventing an answer from the local records. Hugging Face is the
  // default, but its Inference Providers now need pre-paid credits, so any
  // compatible endpoint (Groq, OpenRouter, Gemini, a local server) can be used.
  daveApiUrl:
    process.env.DAVE_API_URL?.trim() ||
    process.env.HUGGINGFACE_API_URL?.trim() ||
    "https://router.huggingface.co/v1/chat/completions",
  daveApiKey:
    process.env.DAVE_API_KEY?.trim() || process.env.HUGGINGFACE_API_KEY?.trim() || null,
  daveModel:
    process.env.DAVE_MODEL?.trim() ||
    process.env.HUGGINGFACE_MODEL?.trim() ||
    "meta-llama/Llama-3.1-8B-Instruct",
  // One-time keys for people outside the two servers (/dave-key).
  daveKeysFile: process.env.DAVE_KEYS_FILE?.trim() || "data/dave-keys.json",
  // A forum post is a channel, so Discord rate-limits creations hard: pace them
  // instead of bursting into a multi-minute 429.
  forumPostDelayMs: readNumber(process.env.FORUM_POST_DELAY_MS, 2500, { max: 60_000 }),
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
