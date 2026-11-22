import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * People who may stay in the preview but never join the real server through
 * the #join-server button, and why. Stored on disk so a restart doesn't
 * quietly let them back in.
 */
export function createJoinBlockStore({ file = null } = {}) {
  let blocks = [];

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no join blocks: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ blocks }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save join blocks to ${file}: ${error.message}`);
    }
  }

  return {
    /** Add or replace the block for one user. */
    block({ guildId, userId, reason, moderatorId = null }) {
      const record = {
        guildId,
        userId,
        reason: (reason ?? "").trim() || "No reason given",
        moderatorId,
        at: new Date().toISOString(),
      };

      blocks = blocks.filter(
        (entry) => !(entry.guildId === guildId && entry.userId === userId),
      );
      blocks.push(record);
      save();
      return record;
    },

    get(guildId, userId) {
      return blocks.find((entry) => entry.guildId === guildId && entry.userId === userId) ?? null;
    },

    lift(guildId, userId) {
      const before = blocks.length;
      blocks = blocks.filter(
        (entry) => !(entry.guildId === guildId && entry.userId === userId),
      );
      if (blocks.length === before) return false;
      save();
      return true;
    },

    list(guildId) {
      return blocks.filter((entry) => entry.guildId === guildId);
    },

    get count() {
      return blocks.length;
    },
  };
}
