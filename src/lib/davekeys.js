import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.js";

/** No I, O, 0 or 1: a key gets read out loud and typed back in by hand. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const KEY_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** A fresh key looks like `K7QM-3H2P`. */
export function createDaveKey() {
  const bytes = randomBytes(8);
  let text = "";
  for (const byte of bytes) text += ALPHABET[byte % ALPHABET.length];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

/**
 * One-time keys for people who aren't in the main or preview server. A manager
 * issues a key to one person; it works once and only for them.
 */
export function createDaveKeyStore({ file = null } = {}) {
  let keys = {};

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      keys = parsed && typeof parsed.keys === "object" && parsed.keys ? parsed.keys : {};
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no Dave keys: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ keys }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save Dave keys to ${file}: ${error.message}`);
    }
  }

  return {
    /** Issue a key for one person. Staff check is the command's job. */
    create({ userId, createdBy = null, note = null } = {}) {
      const id = String(userId ?? "").trim();
      if (!id) throw new UserError("Pick the person the key is for.");

      let key = createDaveKey();
      while (keys[key]) key = createDaveKey();

      const record = {
        key,
        userId: id,
        createdBy: createdBy ? String(createdBy) : null,
        note: note ? String(note).slice(0, 100) : null,
        createdAt: new Date().toISOString(),
        usedAt: null,
        usedBy: null,
      };
      keys[key] = record;
      save();
      return record;
    },

    /**
     * Check a key without spending it, so a failed answer doesn't burn the only
     * use the person has.
     */
    authorize(rawKey, userId) {
      const key = String(rawKey ?? "").trim().toUpperCase();
      const record = keys[key];

      if (!KEY_PATTERN.test(key) || !record) {
        return { ok: false, message: "That one-time key doesn't exist — check it was typed correctly." };
      }
      if (record.usedAt) {
        return { ok: false, message: "That one-time key has already been used — ask a manager for a new one." };
      }
      if (record.userId && record.userId !== String(userId ?? "")) {
        return { ok: false, message: "That one-time key was issued to someone else." };
      }
      return { ok: true, record };
    },

    /** Spend a key once its answer has been delivered. */
    consume(rawKey, userId) {
      const check = this.authorize(rawKey, userId);
      if (!check.ok) return null;

      const record = {
        ...check.record,
        usedAt: new Date().toISOString(),
        usedBy: userId ? String(userId) : null,
      };
      keys[check.record.key] = record;
      save();
      return record;
    },

    /** How many keys are still unused. */
    count() {
      return Object.values(keys).filter((record) => !record.usedAt).length;
    },
  };
}
