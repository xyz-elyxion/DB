import { UserError } from "./errors.js";

export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTE_LENGTH = 200;
export const MAX_AMOUNT = 25;
export const MAX_ENTRIES = 20;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** The reputation a record starts with. */
export function emptyReputation() {
  return { score: 0, entries: [], givers: {} };
}

/**
 * The reputation stored on a record, in a shape the rest of the code can rely
 * on. Records saved before reputation existed simply read as zero.
 */
export function readReputation(record) {
  const saved = record?.reputation;
  const source = typeof saved === "number" ? { score: saved } : saved ?? {};

  const score = Number(source.score);
  const entries = Array.isArray(source.entries)
    ? source.entries.filter((entry) => entry && typeof entry === "object")
    : [];
  const givers = source.givers && typeof source.givers === "object" ? { ...source.givers } : {};

  return {
    score: Number.isFinite(score) ? score : 0,
    entries: entries.slice(0, MAX_ENTRIES),
    givers,
  };
}

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

/**
 * Apply a reputation change to a record. Pure: the caller stores the returned
 * reputation on the record and saves the database.
 *
 * A member can hand out one point per record per cooldown (a day by default);
 * a negative amount is how a manager takes points away.
 */
export function giveReputation(
  record,
  { fromId, amount = 1, note = null, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {},
) {
  if (!record) throw new UserError("That member doesn't have a record in the database.");
  if (!fromId) throw new UserError("Say who is giving the reputation.");
  if (record.userId && String(record.userId) === String(fromId)) {
    throw new UserError("You can't give reputation to yourself.");
  }

  const points = parseRepAmount(amount);
  const reason = normalizeRepNote(note);
  const current = readReputation(record);

  if (points > 0) {
    const last = current.givers[fromId] ?? null;
    if (last !== null) {
      const wait = last + cooldownMs - now;
      if (wait > 0) {
        throw new UserError(
          `You already gave reputation to <@${record.userId ?? record.id}> — ` +
            `try again in ${timeLeft(wait)}.`,
        );
      }
    }
  }

  const reputation = {
    score: current.score + points,
    entries: [
      {
        fromId: String(fromId),
        amount: points,
        note: reason,
        at: new Date(now).toISOString(),
      },
      ...current.entries,
    ].slice(0, MAX_ENTRIES),
    givers: { ...current.givers },
  };
  if (points > 0) reputation.givers[fromId] = now;

  return { reputation, before: current.score, changed: points };
}

/** The members with the most reputation, highest first, with their rank. */
export function reputationBoard(records = [], { limit = 10, page = 1 } = {}) {
  const ranked = records
    .map((record) => ({ record, score: readReputation(record).score }))
    .filter((row) => row.score !== 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.record.updatedAt ?? "").localeCompare(String(b.record.updatedAt ?? "")),
    )
    .map((row, index) => ({
      recordId: row.record.id,
      userId: row.record.userId ?? null,
      name: `${row.record.firstName ?? ""} ${row.record.lastName ?? ""}`.trim(),
      score: row.score,
      rank: index + 1,
    }));

  const perPage = Math.max(1, limit);
  const pages = Math.max(1, Math.ceil(ranked.length / perPage));
  const current = Math.min(Math.max(1, page), pages);

  return {
    entries: ranked.slice((current - 1) * perPage, current * perPage),
    total: ranked.length,
    page: current,
    pages,
  };
}

/** Where one record sits on that board, or null when it has no points. */
export function reputationRank(records, recordId) {
  const board = reputationBoard(records, { limit: Number.MAX_SAFE_INTEGER });
  return board.entries.find((entry) => entry.recordId === recordId)?.rank ?? null;
}
