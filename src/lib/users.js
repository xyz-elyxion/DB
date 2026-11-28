import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.js";
import { normalizeReputation, parseReputation } from "./reputation.js";

export const MAX_ROLES = 10;
export const MAX_ROLE_LENGTH = 32;

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{2,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const GENDER_PATTERN = /^[\p{L}\p{M}' .-]{2,32}$/u;
const CLASS_PATTERN = /^[\p{L}\p{N}\p{M} '.,&/()#-]{1,40}$/u;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/** How to name the record that already holds a taken username or email. */
const describeOwner = (record) =>
  record.userId
    ? `<@${record.userId}>`
    : `**${record.firstName} ${record.lastName}** (unassigned)`;

/**
 * Read a date of birth as YYYY-MM-DD or DD/MM/YYYY (also DD-MM-YYYY) and store
 * it as ISO YYYY-MM-DD. Impossible days (31/02) and future dates are rejected.
 */
export function parseDateOfBirth(value, { now = new Date() } = {}) {
  const text = String(value ?? "").trim();
  let year;
  let month;
  let day;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    [, year, month, day] = iso;
  } else {
    const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!local) return null;
    [, day, month, year] = local;
  }

  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }

  const today = now instanceof Date ? now : new Date(now);
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() > todayStart) return null;

  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Whole years since an ISO date of birth, or null when it isn't one. */
export function ageFromDateOfBirth(iso, { now = new Date() } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const today = now instanceof Date ? now : new Date(now);
  const todayMonth = today.getUTCMonth() + 1;
  const todayDay = today.getUTCDate();

  let age = today.getUTCFullYear() - year;
  if (todayMonth < month || (todayMonth === month && todayDay < day)) age -= 1;
  return Math.max(0, age);
}

/** "Student, Prefect" -> ["Student", "Prefect"]; an empty string clears them. */
export function parseRoles(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const roles = [];
  for (const raw of text.split(",")) {
    const role = clean(raw);
    if (!role) continue;
    if (role.length > MAX_ROLE_LENGTH) {
      throw new UserError(`Each role name must be ${MAX_ROLE_LENGTH} characters or fewer.`);
    }
    if (!roles.some((existing) => existing.toLowerCase() === role.toLowerCase())) roles.push(role);
  }

  if (roles.length > MAX_ROLES) {
    throw new UserError(`A user can have at most ${MAX_ROLES} roles.`);
  }
  return roles;
}

/**
 * Validate and tidy one record. Full profiles need every field; partial ones
 * (used by /edit-user) only touch the fields that were given.
 */
export function normalizeProfile(input = {}, { partial = false } = {}) {
  const profile = {};

  const read = (key) => {
    const value = input?.[key];
    return value === undefined || value === null ? undefined : String(value);
  };
  const wanted = (key) => (partial ? read(key) !== undefined : true);
  const text = (key, label, max) => {
    const value = clean(read(key));
    if (!value) throw new UserError(`${label} is required.`);
    if (value.length > max) throw new UserError(`${label} must be ${max} characters or fewer.`);
    return value;
  };

  if (wanted("firstName")) {
    const value = text("firstName", "First name", 50);
    if (!NAME_PATTERN.test(value)) {
      throw new UserError(
        "First name can only contain letters, spaces, apostrophes, periods and hyphens.",
      );
    }
    profile.firstName = value;
  }

  if (wanted("lastName")) {
    const value = text("lastName", "Last name", 50);
    if (!NAME_PATTERN.test(value)) {
      throw new UserError(
        "Last name can only contain letters, spaces, apostrophes, periods and hyphens.",
      );
    }
    profile.lastName = value;
  }

  if (wanted("email")) {
    const value = text("email", "Email", 254).toLowerCase();
    if (!EMAIL_PATTERN.test(value)) {
      throw new UserError("That email doesn't look right — it should look like name@example.com.");
    }
    profile.email = value;
  }

  if (wanted("username")) {
    const value = text("username", "Username", 32);
    if (!USERNAME_PATTERN.test(value)) {
      throw new UserError(
        "Username must be 2–32 characters: letters, numbers, dots, underscores or hyphens.",
      );
    }
    profile.username = value;
  }

  if (wanted("dateOfBirth")) {
    const value = clean(read("dateOfBirth"));
    // Birthdays are optional: not every list has one, and an empty value just
    // clears it. The card then shows "Not set" instead of an age.
    if (!value) {
      profile.dateOfBirth = null;
    } else {
      const iso = parseDateOfBirth(value);
      if (!iso) {
        throw new UserError(
          "Date of birth must be a real date in the past, like 2005-04-12 or 12/04/2005.",
        );
      }
      const age = ageFromDateOfBirth(iso);
      if (age === null || age > 120) {
        throw new UserError("Date of birth can't be more than 120 years ago.");
      }
      profile.dateOfBirth = iso;
    }
  }

  if (wanted("class")) {
    const value = text("class", "Class", 40);
    if (!CLASS_PATTERN.test(value)) {
      throw new UserError(
        "Class can only contain letters, numbers, spaces and ' . , & / ( ) # -.",
      );
    }
    profile.class = value;
  }

  if (wanted("gender")) {
    const value = text("gender", "Gender", 32);
    if (!GENDER_PATTERN.test(value)) {
      throw new UserError(
        "Gender must be 2–32 letters, spaces, apostrophes, periods or hyphens.",
      );
    }
    profile.gender = value;
  }

  if (wanted("reputation")) {
    // Reputation is part of the record, set by staff like any other field.
    profile.reputation = parseReputation(input?.reputation);
  }

  if (read("roles") !== undefined) profile.roles = parseRoles(read("roles"));

  if (partial && Object.keys(profile).length === 0) {
    throw new UserError("Give at least one field to change.");
  }

  return profile;
}

/**
 * JSON-backed member records: one file per bot, one bucket per server. Usernames
 * and emails are unique inside a server (compared without case).
 */
export function createUserStore({ file = null, guildId = null } = {}) {
  let guilds = {};

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      guilds = parsed && typeof parsed.guilds === "object" && parsed.guilds ? parsed.guilds : {};
      // Records saved before ids existed are keyed by the member they belong
      // to, and records saved before reputation existed start at zero.
      for (const guild of Object.values(guilds)) {
        for (const [key, record] of Object.entries(guild?.users ?? {})) {
          if (record && typeof record === "object") {
            record.id ??= record.userId ?? key;
            record.reputation = normalizeReputation(record.reputation);
          }
        }
      }
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no user records: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ guilds }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save user records to ${file}: ${error.message}`);
    }
  }

  function bucket(gid = guildId) {
    const guild = (guilds[gid] ??= {});
    guild.users ??= {};
    return guild;
  }

  function records(gid) {
    return Object.values(bucket(gid).users);
  }

  function clash(gid, field, value, exceptId) {
    const needle = String(value ?? "").toLowerCase();
    if (!needle) return null;
    return (
      records(gid).find(
        (record) =>
          record.id !== exceptId && String(record[field] ?? "").toLowerCase() === needle,
      ) ?? null
    );
  }

  return {
    get(gid = guildId, id) {
      return bucket(gid).users[id] ?? null;
    },

    count(gid = guildId) {
      return records(gid).length;
    },

    /** Everyone, sorted by name, for listings. */
    all(gid = guildId) {
      return records(gid).sort((a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
      );
    },

    findByUsername(gid = guildId, username) {
      const needle = String(username ?? "").trim().toLowerCase();
      if (!needle) return null;
      return (
        records(gid).find((record) => String(record.username).toLowerCase() === needle) ?? null
      );
    },

    /**
     * `userId` may be left out: the record is then unassigned and gets its own
     * id, so it can still be found by username, edited and deleted.
     */
    create({ guildId: gid = guildId, userId = null, createdBy = null, ...fields } = {}) {
      if (!gid) throw new UserError("A server is required to store a user record.");

      const guild = bucket(gid);
      const id = userId ? String(userId) : `unassigned-${randomUUID()}`;
      if (guild.users[id]) {
        throw new UserError(`<@${userId}> already has a record — use \`/edit-user\` to change it.`);
      }

      const profile = normalizeProfile(fields);
      profile.roles ??= [];

      const usernameClash = clash(gid, "username", profile.username, id);
      if (usernameClash) {
        throw new UserError(
          `The username **${profile.username}** is already used by ${describeOwner(usernameClash)}.`,
        );
      }

      const emailClash = clash(gid, "email", profile.email, id);
      if (emailClash) {
        throw new UserError(`That email is already registered to ${describeOwner(emailClash)}.`);
      }

      const now = new Date().toISOString();
      const record = {
        id,
        userId: userId ? String(userId) : null,
        ...profile,
        createdAt: now,
        updatedAt: now,
        createdBy,
      };
      guild.users[id] = record;
      save();
      return record;
    },

    update({ guildId: gid = guildId, recordId, ...patch } = {}) {
      const guild = bucket(gid);
      const existing = guild.users[recordId];
      if (!existing) {
        throw new UserError(
          "That record doesn't exist — use `/create-user` to add one.",
        );
      }

      const changes = normalizeProfile(patch, { partial: true });

      if (changes.username) {
        const usernameClash = clash(gid, "username", changes.username, recordId);
        if (usernameClash) {
          throw new UserError(
            `The username **${changes.username}** is already used by ${describeOwner(usernameClash)}.`,
          );
        }
      }
      if (changes.email) {
        const emailClash = clash(gid, "email", changes.email, recordId);
        if (emailClash) {
          throw new UserError(`That email is already registered to ${describeOwner(emailClash)}.`);
        }
      }

      const record = { ...existing, ...changes, updatedAt: new Date().toISOString() };
      guild.users[recordId] = record;
      save();
      return { record, before: existing, changed: Object.keys(changes) };
    },

    /**
     * Store bookkeeping fields that aren't part of the profile — currently the
     * forum post the record lives in. Never touches the validated fields.
     */
    setMeta({ guildId: gid = guildId, recordId, meta } = {}) {
      const guild = bucket(gid);
      const existing = guild.users[recordId];
      if (!existing) return null;

      const record = { ...existing, ...meta };
      guild.users[recordId] = record;
      save();
      return record;
    },

    /** Returns the deleted record, or null when there was nothing to delete. */
    remove(gid = guildId, recordId) {
      const guild = bucket(gid);
      const existing = guild.users[recordId] ?? null;
      if (!existing) return null;
      delete guild.users[recordId];
      save();
      return existing;
    },
  };
}
