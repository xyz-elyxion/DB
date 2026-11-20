/** An error whose message is safe (and useful) to show to the user in Discord. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A short, human-friendly description of a Discord API error. */
export function describeError(error) {
  if (!error) return "unknown error";
  const code = error.code ? ` (code ${error.code})` : "";
  return `${error.message ?? String(error)}${code}`;
}
