import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Old cases are dropped so the file cannot grow forever. */
export const MAX_STORED_CASES = 5000;

/**
 * A tiny JSON-backed case log. Every moderation action that leaves a trace
 * (ban, kick, timeout, warn …) becomes a numbered case, so warnings survive
 * restarts and `/case 12` still works tomorrow.
 */
export function createCaseStore({ file = null } = {}) {
  let cases = [];
  let nextId = 1;

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      cases = Array.isArray(parsed.cases) ? parsed.cases : [];
      nextId = Number.isInteger(parsed.nextId) ? parsed.nextId : cases.length + 1;
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no cases: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ nextId, cases }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save moderation cases to ${file}: ${error.message}`);
    }
  }

  return {
    add(entry) {
      const record = { id: nextId++, at: new Date().toISOString(), ...entry };
      cases.push(record);
      if (cases.length > MAX_STORED_CASES) cases = cases.slice(-MAX_STORED_CASES);
      save();
      return record;
    },

    get(guildId, id) {
      return cases.find((record) => record.guildId === guildId && record.id === id) ?? null;
    },

    forUser(guildId, userId, type = null) {
      return cases.filter(
        (record) =>
          record.guildId === guildId &&
          record.targetId === userId &&
          (type === null || record.type === type),
      );
    },

    remove(guildId, id) {
      const before = cases.length;
      cases = cases.filter((record) => !(record.guildId === guildId && record.id === id));
      if (cases.length === before) return false;
      save();
      return true;
    },

    clearForUser(guildId, userId, type = null) {
      const before = cases.length;
      cases = cases.filter(
        (record) =>
          !(
            record.guildId === guildId &&
            record.targetId === userId &&
            (type === null || record.type === type)
          ),
      );
      if (cases.length !== before) save();
      return before - cases.length;
    },

    get count() {
      return cases.length;
    },
  };
}
