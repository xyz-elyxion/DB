import { UserError } from "./errors.js";

export const MAX_MASS_RECORDS = 100;

const SEPARATORS = ["|", "\t", ";"];
const MEMBER_PATTERN = /^(?:<@!?(\d{16,20})>|(\d{16,20}))$/;

/** Accepts `<@123>`, `<@!123>` or a bare snowflake. */
export function parseMemberId(value) {
  const match = MEMBER_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  return match[1] ?? match[2];
}

function splitFields(line) {
  for (const separator of SEPARATORS) {
    if (line.includes(separator)) return line.split(separator).map((part) => part.trim());
  }
  return null;
}

/**
 * One record per line:
 *
 *   member | first name | last name | email | username | date of birth | class | gender | roles
 *
 * Blank lines and lines starting with # or // are ignored, so a pasted sheet
 * can keep its header commented out. Bad lines are reported, not fatal.
 */
export function parseMassRecords(text) {
  const records = [];
  const problems = [];

  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) return;

      const lineNumber = index + 1;
      try {
        const parts = splitFields(line);
        if (!parts) {
          throw new UserError("separate the fields with |, a tab or ;");
        }
        if (parts.length < 8) {
          throw new UserError(`expected 8 or 9 fields, found ${parts.length}`);
        }
        if (parts.length > 9) {
          throw new UserError(
            `expected 8 or 9 fields, found ${parts.length} — put every role in one comma-separated field`,
          );
        }

        const [
          member,
          firstName,
          lastName,
          email,
          username,
          dateOfBirth,
          className,
          gender,
          roles = "",
        ] = parts;

        const userId = parseMemberId(member);
        if (!userId) {
          throw new UserError(`"${member}" isn't a member — use <@id> or the numeric user ID`);
        }

        records.push({
          line: lineNumber,
          userId,
          firstName,
          lastName,
          email,
          username,
          dateOfBirth,
          class: className,
          gender,
          roles,
        });
      } catch (error) {
        problems.push({
          line: lineNumber,
          text: line.length > 120 ? `${line.slice(0, 119)}…` : line,
          reason: error instanceof UserError ? error.message : String(error?.message ?? error),
        });
      }
    });

  return { records, problems };
}

/**
 * Add every valid line as its own record. A line that fails (bad email, taken
 * username, already has a record) is reported and does not stop the rest.
 */
export function addMassRecords({ users, guildId, text, createdBy = null } = {}) {
  if (!users) throw new UserError("The user database isn't running.");

  const { records, problems } = parseMassRecords(text);
  if (records.length === 0 && problems.length === 0) {
    throw new UserError(
      "There was nothing to add — paste one record per line: " +
        "member | first name | last name | email | username | date of birth | class | gender | roles",
    );
  }
  if (records.length > MAX_MASS_RECORDS) {
    throw new UserError(
      `That's ${records.length} records — add at most ${MAX_MASS_RECORDS} at a time, then run it again.`,
    );
  }

  const added = [];
  for (const { line, ...fields } of records) {
    try {
      added.push(users.create({ guildId, createdBy, ...fields }));
    } catch (error) {
      problems.push({
        line,
        text: `${fields.firstName} ${fields.lastName}`.trim(),
        reason: error instanceof UserError ? error.message : String(error?.message ?? error),
      });
    }
  }

  problems.sort((a, b) => a.line - b.line);
  return { added, problems };
}
