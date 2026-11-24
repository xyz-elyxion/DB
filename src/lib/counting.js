import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A counting message is plain digits and nothing else. */
export function parseCount(content) {
  const text = String(content ?? "").trim();
  if (!/^\d{1,16}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * JSON-backed counting channel. The server counts 1, 2, 3… in one channel; a
 * wrong number, or the same person twice in a row, starts the chain over at 1.
 * The highest number ever reached is kept across resets and restarts.
 */
export function createCountingStore({ file = null, guildId = null } = {}) {
  let guilds = {};

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      guilds = parsed && typeof parsed.guilds === "object" && parsed.guilds ? parsed.guilds : {};
    } catch (error) {
      console.warn(`Could not read ${file}, starting a fresh count: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ guilds }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save the count to ${file}: ${error.message}`);
    }
  }

  function bucket(gid = guildId) {
    const guild = (guilds[gid] ??= {});
    guild.channelId ??= null;
    guild.count ??= 0;
    guild.record ??= 0;
    guild.lastUserId ??= null;
    return guild;
  }

  function settings(gid = guildId) {
    const guild = bucket(gid);
    return {
      enabled: Boolean(guild.channelId),
      channelId: guild.channelId ?? null,
      count: guild.count,
      next: guild.count + 1,
      record: guild.record,
      lastUserId: guild.lastUserId ?? null,
    };
  }

  return {
    settings,

    /** Point the game at a channel. Switching channels starts again from 1. */
    setChannel(gid = guildId, channelId) {
      const guild = bucket(gid);
      if (guild.channelId !== channelId) {
        guild.channelId = channelId;
        guild.count = 0;
        guild.lastUserId = null;
        save();
      }
      return settings(gid);
    },

    disable(gid = guildId) {
      const guild = bucket(gid);
      guild.channelId = null;
      guild.lastUserId = null;
      save();
      return settings(gid);
    },

    /** Start over at 1 without losing the record. */
    reset(gid = guildId) {
      const guild = bucket(gid);
      guild.count = 0;
      guild.lastUserId = null;
      save();
      return settings(gid);
    },

    /**
     * Judge one message. Returns `{ action: "ignored" }`, `{ action: "counted" }`
     * or `{ action: "reset", reason, expected, got, previous, record, ruinedBy }`.
     */
    handleMessage(message) {
      const guild = bucket(message?.guild?.id ?? message?.guildId ?? guildId);
      if (!message || !guild.channelId || message.channelId !== guild.channelId) {
        return { action: "ignored" };
      }
      if (message.author?.bot || message.webhookId || message.system) return { action: "ignored" };

      const value = parseCount(message.content);
      if (value === null) return { action: "ignored" };

      const expected = guild.count + 1;
      const previous = guild.count;
      const ruinedBy = message.author.id;

      const startOver = (reason) => {
        guild.count = 0;
        guild.lastUserId = null;
        save();
        return {
          action: "reset",
          reason,
          expected,
          got: value,
          previous,
          record: guild.record,
          ruinedBy,
        };
      };

      if (value !== expected) return startOver("wrong-number");
      if (guild.lastUserId === ruinedBy) return startOver("same-user");

      guild.count = value;
      guild.lastUserId = ruinedBy;
      const beatenRecord = value > guild.record;
      if (beatenRecord) guild.record = value;
      save();

      return {
        action: "counted",
        count: value,
        next: value + 1,
        record: guild.record,
        beatenRecord,
      };
    },
  };
}
