const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Discord refuses timeouts longer than 28 days. */
export const MAX_TIMEOUT_MS = 28 * DAY;

const UNITS = { s: SECOND, m: MINUTE, h: HOUR, d: DAY };

/**
 * "30" -> 30 minutes, "10m" -> 10 minutes, "2h", "1d" … Returns null when the
 * text is not a duration, so the command can say so instead of guessing.
 */
export function parseDuration(input) {
  if (input === undefined || input === null) return null;

  const text = String(input).trim().toLowerCase().replace(/[\s_]+/g, "");
  if (!text) return null;

  const match = /^(\d{1,5})([smhd])?$/.exec(text);
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  const ms = amount * UNITS[match[2] ?? "m"];
  return ms > 0 ? ms : null;
}

/** 5_400_000 -> "1h 30m". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  let left = Math.floor(ms / SECOND);
  const parts = [];

  const days = Math.floor(left / 86400);
  left -= days * 86400;
  const hours = Math.floor(left / 3600);
  left -= hours * 3600;
  const minutes = Math.floor(left / 60);
  left -= minutes * 60;

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (left) parts.push(`${left}s`);

  return parts.join(" ");
}
