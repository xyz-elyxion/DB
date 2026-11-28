import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.js";

export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTE_LENGTH = 200;
export const MAX_AMOUNT = 25;
export const MAX_ENTRIES = 20;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** A note is optional; when given it is kept short and on one line. */
export function normalizeRepNote(value) {
  const note = clean(value);
  if (!note) return null;
  if (note.length > MAX_NOTE_LENGTH) {
    throw new UserError(`A reputation note can be at most ${MAX_NOTE_LENGTH} characters.`);
  }
  return note;
}

/** +1 by default; managers may take points away with a negative amount. */
export function parseRepAmount(value, { max = MAX_AMOUNT } = {}) {
  if (value === undefined || value === null || value === "") return 1;

  const text = String(value).trim();
  const amount = Number.parseInt(text, 10);
  if (!Number.isFinite(amount) || String(amount) !== text) {
    throw new UserError("The amount has to be a whole number of points.");
  }
  if (amount === 0) throw new UserError("An amount of 0 would change nothing.");

  const limit = Math.min(Math.abs(max), MAX_AMOUNT);
  if (Math.abs(amount) > limit) {
    throw new UserError(`One change can be at most ${limit} points.`);
  }
  return amount;
}

function timeLeft(ms) {
  const totalMinutes = Math.ceil(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function emptyEntry(userId) {
  return { userId, score: 0, entries: [], givers: {}, updatedAt: null };
}

/**
 * Reputation for the student database: JSON-backed, one bucket per server, keyed
 * by the Discord member so it follows them when a record is created or edited.
 *
 * A member can hand out one point per target per cooldown (a day by default).
 * Managers can move more at once with a negative amount, and reset a member.
 */
export function createReputationStore({
  file = null,
  guildId = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
} = {}) {
  let guilds = {};

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      guilds = parsed && typeof parsed.guilds === "object" && parsed.guilds ? parsed.guilds : {};
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no reputation: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ guilds }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save reputation to ${file}: ${error.message}`);
    }
  }

  function bucket(gid = guildId) {
    const guild = (guilds[gid] ??= {});
    guild.members ??= {};
    return guild;
  }

  // Reads never create a server bucket, so looking something up can't end up
  // saved as an empty "null" guild when SOURCE_GUILD_ID isn't set yet.
  function entries(gid) {
    return Object.values(guilds[gid]?.members ?? {});
  }

  return {
    /** A member's reputation, or a zeroed one when they have none yet. */
    get(gid = guildId, userId) {
      const entry = guilds[gid]?.members?.[userId];
      return entry ? { ...entry } : emptyEntry(userId ?? null);
    },

    score(gid = guildId, userId) {
      return guilds[gid]?.members?.[userId]?.score ?? 0;
    },

    /** How many members have reputation at all in this server. */
    count(gid = guildId) {
      return entries(gid).filter((entry) => entry.score !== 0).length;
    },

    /** Position among members with a non-zero score, or null for none. */
    rank(gid = guildId, userId) {
      const board = this.top(gid, { limit: Number.MAX_SAFE_INTEGER });
      return board.entries.find((entry) => entry.userId === userId)?.rank ?? null;
    },

    give({ guildId: gid = guildId, userId, fromId, amount = 1, note = null } = {}) {
      if (!gid) throw new UserError("A server is required to store reputation.");
      if (!userId) throw new UserError("Say who the reputation is for.");
      if (!fromId) throw new UserError("Say who is giving the reputation.");
      if (String(userId) === String(fromId)) {
        throw new UserError("You can't give reputation to yourself.");
      }

      const points = parseRepAmount(amount);
      const reason = normalizeRepNote(note);

      const guild = bucket(gid);
      const entry = (guild.members[userId] ??= emptyEntry(String(userId)));

      if (points > 0) {
        const last = entry.givers?.[fromId] ?? null;
        if (last !== null) {
          const wait = last + cooldownMs - now();
          if (wait > 0) {
            throw new UserError(
              `You already gave reputation to <@${userId}> — try again in ${timeLeft(wait)}.`,
            );
          }
        }
      }

      const before = entry.score;
      entry.score += points;
      entry.entries = [
        { fromId: String(fromId), amount: points, note: reason, at: new Date(now()).toISOString() },
        ...(entry.entries ?? []),
      ].slice(0, MAX_ENTRIES);
      entry.givers ??= {};
      if (points > 0) entry.givers[fromId] = now();
      entry.updatedAt = new Date(now()).toISOString();

      save();
      return { entry: { ...entry }, before, changed: points };
    },

    /** Wipe a member's reputation. Returns the score that was cleared. */
    reset(gid = guildId, userId, { by = null } = {}) {
      const guild = bucket(gid);
      const entry = guild.members[userId];
      if (!entry) return null;

      const before = entry.score;
      guild.members[userId] = {
        ...emptyEntry(String(userId)),
        updatedAt: new Date(now()).toISOString(),
        resetBy: by ?? null,
      };
      save();
      return before;
    },

    /** The members with the most reputation, highest first. */
    top(gid = guildId, { limit = 10, page = 1 } = {}) {
      const ranked = entries(gid)
        .filter((entry) => entry.score !== 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")),
        )
        .map((entry, index) => ({ userId: entry.userId, score: entry.score, rank: index + 1 }));

      const perPage = Math.max(1, limit);
      const pages = Math.max(1, Math.ceil(ranked.length / perPage));
      const current = Math.min(Math.max(1, page), pages);

      return {
        entries: ranked.slice((current - 1) * perPage, current * perPage),
        total: ranked.length,
        page: current,
        pages,
      };
    },
  };
}
