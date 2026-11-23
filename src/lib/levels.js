import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Nobody gets past this, so a runaway file can't make the curve loop forever. */
export const MAX_LEVEL = 500;

/** XP needed to step from level-1 to `level` (Mee6-style growing curve). */
export function xpForLevel(level) {
  if (level <= 0) return 0;
  return 5 * level * level + 50 * level + 100;
}

/** XP needed to go from level 0 to `level`. */
export function totalXpForLevel(level) {
  let total = 0;
  for (let step = 1; step <= level; step += 1) total += xpForLevel(step);
  return total;
}

export function levelFromTotalXp(xp) {
  const safe = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 0;
  while (level < MAX_LEVEL && safe >= totalXpForLevel(level + 1)) level += 1;
  return level;
}

/** Everything a rank card needs: level, XP inside that level, and how far along. */
export function progressFromTotalXp(xp) {
  const safe = Math.max(0, Math.floor(Number(xp) || 0));
  const level = levelFromTotalXp(safe);
  const base = totalXpForLevel(level);
  const need = xpForLevel(level + 1);
  const into = Math.max(0, Math.min(need, safe - base));
  return {
    level,
    xp: safe,
    into,
    need,
    percent: need > 0 ? Math.min(100, Math.round((into / need) * 100)) : 100,
  };
}

/** A text progress bar, since the bot draws no images. */
export function progressBar(percent, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * JSON-backed XP store. One file holds every member's XP, message count and the
 * server's settings, so levels survive restarts just like moderation cases.
 */
export function createLevelStore({
  file = null,
  guildId = null,
  minXp = 15,
  maxXp = 25,
  cooldownMs = 60_000,
  random = Math.random,
} = {}) {
  const low = Math.max(0, Math.min(minXp, maxXp));
  const high = Math.max(low, maxXp);

  let guilds = {};

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      guilds = parsed && typeof parsed.guilds === "object" && parsed.guilds ? parsed.guilds : {};
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no levels: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ guilds }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save levels to ${file}: ${error.message}`);
    }
  }

  function bucket(gid) {
    const guild = (guilds[gid] ??= { users: {}, settings: {} });
    guild.users ??= {};
    guild.settings ??= {};
    return guild;
  }

  function record(gid, userId) {
    const guild = bucket(gid);
    return (guild.users[userId] ??= { xp: 0, messages: 0, lastAt: 0 });
  }

  function settings(gid) {
    const stored = guilds[gid]?.settings ?? {};
    const rewards = {};
    for (const [level, roleId] of Object.entries(stored.roleRewards ?? {})) {
      const key = Number(level);
      if (Number.isInteger(key) && key > 0 && typeof roleId === "string") rewards[key] = roleId;
    }

    return {
      enabled: stored.enabled !== false,
      noXpChannels: Array.isArray(stored.noXpChannels)
        ? [...new Set(stored.noXpChannels.filter((id) => typeof id === "string"))]
        : [],
      roleRewards: rewards,
      announceChannelId:
        typeof stored.announceChannelId === "string" ? stored.announceChannelId : null,
    };
  }

  function updateSettings(gid, patch) {
    bucket(gid).settings = { ...settings(gid), ...patch };
    save();
    return settings(gid);
  }

  function sortedUsers(gid) {
    const users = guilds[gid]?.users ?? {};
    return Object.entries(users)
      .filter(([, entry]) => (entry?.xp ?? 0) > 0)
      .map(([userId, entry]) => ({
        userId,
        xp: entry.xp,
        messages: entry.messages ?? 0,
        level: levelFromTotalXp(entry.xp),
      }))
      .sort((a, b) => b.xp - a.xp || b.messages - a.messages || a.userId.localeCompare(b.userId));
  }

  function view(gid, userId) {
    const entry = guilds[gid]?.users?.[userId] ?? null;
    return {
      ...progressFromTotalXp(entry?.xp ?? 0),
      messages: entry?.messages ?? 0,
      lastAt: entry?.lastAt ?? 0,
    };
  }

  return {
    settings,

    /** Rates, for /level-settings. */
    xpRange: { min: low, max: high },
    cooldownMs,

    updateSettings,

    setAnnounceChannel(gid, channelId) {
      return updateSettings(gid, { announceChannelId: channelId || null });
    },

    setEnabled(gid, enabled) {
      return updateSettings(gid, { enabled: Boolean(enabled) });
    },

    toggleNoXpChannel(gid, channelId) {
      const current = settings(gid).noXpChannels;
      const enabled = !current.includes(channelId);
      const channels = enabled
        ? [...current, channelId]
        : current.filter((id) => id !== channelId);
      updateSettings(gid, { noXpChannels: channels });
      return { enabled, channels };
    },

    setRoleReward(gid, level, roleId) {
      const rewards = { ...settings(gid).roleRewards };
      if (roleId) rewards[level] = roleId;
      else delete rewards[level];
      updateSettings(gid, { roleRewards: rewards });
      return settings(gid).roleRewards;
    },

    /** Roles whose level has been reached — additive, nothing is taken away. */
    rolesFor(gid, level) {
      return Object.entries(settings(gid).roleRewards)
        .filter(([rewardLevel]) => Number(rewardLevel) <= level)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, roleId]) => roleId);
    },

    get: view,

    count(gid) {
      return sortedUsers(gid).length;
    },

    /** 1-based position, or 0 when they have not earned XP yet. */
    rank(gid, userId) {
      const index = sortedUsers(gid).findIndex((entry) => entry.userId === userId);
      return index === -1 ? 0 : index + 1;
    },

    leaderboard(gid, { page = 1, pageSize = 10 } = {}) {
      const all = sortedUsers(gid);
      const pages = Math.max(1, Math.ceil(all.length / pageSize));
      const current = Math.min(Math.max(1, Math.trunc(page)), pages);
      const start = (current - 1) * pageSize;
      const entries = all.slice(start, start + pageSize).map((entry, index) => ({
        ...entry,
        rank: start + index + 1,
      }));
      return { entries, page: current, pages, total: all.length, pageSize };
    },

    /** Staff XP grant/removal. Returns the new level and whether it went up. */
    addXp({ guildId: gid, userId, amount }) {
      const entry = record(gid, userId);
      const beforeXp = entry.xp;
      const before = levelFromTotalXp(beforeXp);
      entry.xp = Math.max(0, beforeXp + Math.trunc(Number(amount) || 0));
      save();
      return {
        ...progressFromTotalXp(entry.xp),
        messages: entry.messages,
        previousLevel: before,
        leveledUp: levelFromTotalXp(entry.xp) > before,
        gained: entry.xp - beforeXp,
      };
    },

    setLevel({ guildId: gid, userId, level }) {
      const target = Math.max(0, Math.min(MAX_LEVEL, Math.trunc(Number(level) || 0)));
      const entry = record(gid, userId);
      const before = levelFromTotalXp(entry.xp);
      entry.xp = totalXpForLevel(target);
      save();
      return {
        ...progressFromTotalXp(entry.xp),
        messages: entry.messages,
        previousLevel: before,
        leveledUp: target > before,
      };
    },

    reset(gid, userId) {
      const guild = bucket(gid);
      const existed = Object.hasOwn(guild.users, userId);
      delete guild.users[userId];
      save();
      return existed;
    },

    /**
     * Award XP for one chat message, or null when the message shouldn't count.
     * Cooldown is per member and stored, so a restart doesn't reset it.
     */
    handleMessage(message, { now = Date.now() } = {}) {
      const gid = message?.guild?.id ?? null;
      if (!gid || (guildId && gid !== guildId)) return null;
      if (!message.author || message.author.bot) return null;
      if (message.webhookId || message.system) return null;

      const config = settings(gid);
      if (!config.enabled) return null;

      const channelId = message.channelId ?? message.channel?.id ?? null;
      if (channelId && config.noXpChannels.includes(channelId)) return null;

      const entry = guilds[gid]?.users?.[message.author.id] ?? null;
      if (entry?.lastAt && now - entry.lastAt < cooldownMs) return null;

      const existing = record(gid, message.author.id);
      const before = levelFromTotalXp(existing.xp);
      const amount = Math.round(low + random() * (high - low));

      existing.xp += amount;
      existing.messages += 1;
      existing.lastAt = now;
      save();

      const after = progressFromTotalXp(existing.xp);
      return {
        guildId: gid,
        userId: message.author.id,
        amount,
        xp: after.xp,
        level: after.level,
        previousLevel: before,
        leveledUp: after.level > before,
        messages: existing.messages,
        progress: after,
      };
    },
  };
}
