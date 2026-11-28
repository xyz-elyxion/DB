import { UserError } from "./errors.js";

export const MAX_REPUTATION = 1_000_000;

/**
 * Reputation is one whole number kept on the record, beside the name, class and
 * the rest of the profile. Saves written when it was a bigger object stored a
 * `score` inside it; only that number matters now, so both shapes read the same.
 */
export function normalizeReputation(value) {
  const source = value && typeof value === "object" ? value.score : value;
  const points = Math.trunc(Number(source ?? 0));
  return Number.isFinite(points) ? points : 0;
}

/** Validate the points staff type into /create-user or /edit-user. */
export function parseReputation(value) {
  if (value === undefined || value === null || value === "") return 0;

  const points = Number(value);
  if (!Number.isInteger(points)) {
    throw new UserError("Reputation has to be a whole number of points.");
  }
  if (points < 0 || points > MAX_REPUTATION) {
    throw new UserError(`Reputation has to be between 0 and ${MAX_REPUTATION}.`);
  }
  return points;
}
