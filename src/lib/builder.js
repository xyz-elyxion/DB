import { CHANNEL_TYPE_IDS } from "./snapshot.js";
import { describeError, sleep } from "./errors.js";
import { copyChannelMessages } from "./messages.js";
import { readOnlyOverwrites } from "./preview.js";

export const CHANNEL_SETTING_FIELDS = [
  "topic",
  "nsfw",
  "rateLimitPerUser",
  "defaultAutoArchiveDuration",
  "defaultThreadRateLimitPerUser",
  "bitrate",
  "userLimit",
  "rtcRegion",
  "videoQualityMode",
  "defaultSortOrder",
  "defaultForumLayout",
];

const MAX_EMOJI_BYTES = 256 * 1024;
const EMOJI_SLOTS = 50;

async function resolveRole(guild, id) {
  const cached = guild.roles.cache.get(id);
  if (cached) return cached;
  if (typeof guild.roles.fetch === "function") {
    return guild.roles.fetch(id).catch(() => null);
  }
  return null;
}

async function resolveChannel(guild, id) {
  const cached = guild.channels.cache.get(id);
  if (cached) return cached;
  if (typeof guild.channels.fetch === "function") {
    return guild.channels.fetch(id).catch(() => null);
  }
  return null;
}

async function memberInGuild(guild, userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  let member = guild.members?.cache?.get(userId) ?? null;
  if (!member && typeof guild.members?.fetch === "function") {
    member = await guild.members.fetch(userId).catch(() => null);
  }
  cache.set(userId, member);
  return member;
}

export function channelCreatePayload(entry, parent, overwrites) {
  const payload = {
    name: entry.name,
    type: CHANNEL_TYPE_IDS.get(entry.type),
    permissionOverwrites: overwrites,
  };

  if (parent) payload.parent = parent.id;

  if (entry.type === "text" || entry.type === "announcement") {
    Object.assign(payload, {
      topic: entry.topic ?? undefined,
      nsfw: entry.nsfw,
      rateLimitPerUser: entry.rateLimitPerUser ?? 0,
      defaultAutoArchiveDuration: entry.defaultAutoArchiveDuration ?? undefined,
      defaultThreadRateLimitPerUser: entry.defaultThreadRateLimitPerUser ?? undefined,
    });
  } else if (entry.type === "voice" || entry.type === "stage") {
    Object.assign(payload, {
      bitrate: entry.bitrate ?? undefined,
      userLimit: entry.userLimit ?? 0,
      rtcRegion: entry.rtcRegion ?? undefined,
      videoQualityMode: entry.videoQualityMode ?? undefined,
    });
  } else if (entry.type === "forum" || entry.type === "media") {
    Object.assign(payload, {
      topic: entry.topic ?? undefined,
      nsfw: entry.nsfw,
      rateLimitPerUser: entry.rateLimitPerUser ?? 0,
      defaultAutoArchiveDuration: entry.defaultAutoArchiveDuration ?? undefined,
      defaultThreadRateLimitPerUser: entry.defaultThreadRateLimitPerUser ?? undefined,
      defaultSortOrder: entry.defaultSortOrder ?? undefined,
      defaultForumLayout: entry.defaultForumLayout ?? undefined,
    });
    if (entry.availableTags?.length) payload.availableTags = entry.availableTags;
    if (entry.defaultReactionEmoji) payload.defaultReactionEmoji = entry.defaultReactionEmoji;
  }

  // Discord rejects unknown fields, and `undefined` only adds noise.
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  return payload;
}

export async function buildOverwrites(entry, roleMap, guild, memberCache, report) {
  const resolved = [];
  let droppedMembers = 0;

  for (const overwrite of entry.overwrites) {
    if (overwrite.type === "role") {
      const role = roleMap.get(overwrite.id);
      if (!role) continue;
      resolved.push({ id: role.id, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) });
      continue;
    }

    const member = await memberInGuild(guild, overwrite.id, memberCache);
    if (!member) {
      droppedMembers += 1;
      continue;
    }
    resolved.push({ id: member.id, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) });
  }

  if (droppedMembers) {
    report.warnings.push(
      `#${entry.name}: skipped ${droppedMembers} permission overwrite(s) for members who aren't in the target server.`,
    );
  }

  return resolved;
}

async function syncRolePositions(guild, plan, roleMap, report, reason) {
  const me = guild.members?.me ?? null;
  if (!me?.roles?.highest) return;

  const ceiling = me.roles.highest.position - 1;
  if (ceiling < 1) return;

  const ordered = plan.roles
    .filter((entry) => entry.action !== "skip" && roleMap.has(entry.sourceId))
    .map((entry) => ({ entry, role: roleMap.get(entry.sourceId) }))
    .filter(({ role }) => role && !role.managed)
    .sort((a, b) => b.entry.position - a.entry.position);

  const movable = ordered.slice(0, ceiling);
  if (movable.length < ordered.length) {
    report.warnings.push(
      `Only the top ${movable.length} of ${ordered.length} roles could be reordered: my role has to stay above the ones I move.`,
    );
  }

  let position = movable.length;
  for (const { role } of movable) {
    if (role.position !== position) {
      try {
        await role.setPosition(position, reason);
      } catch (error) {
        report.warnings.push(`Couldn't move role “${role.name}”: ${describeError(error)}`);
      }
    }
    position -= 1;
  }
}

async function applySetting(entry, { guild, channelMap, report, reason }) {
  const has = (method) => typeof guild[method] === "function";
  const channel = entry.sourceChannelId ? channelMap.get(entry.sourceChannelId) ?? null : null;

  switch (entry.key) {
    case "name":
      if (has("setName")) await guild.setName(entry.value, reason);
      break;
    case "icon":
      if (has("setIcon")) await guild.setIcon(entry.value, reason);
      break;
    case "afkChannel":
      if (!channel) throw new Error("the AFK channel wasn't created");
      if (has("setAFKChannel")) await guild.setAFKChannel(channel, reason);
      break;
    case "afkTimeout":
      if (has("setAFKTimeout")) await guild.setAFKTimeout(entry.value, reason);
      break;
    case "systemChannel":
      if (!channel) throw new Error("the system channel wasn't created");
      if (has("setSystemChannel")) await guild.setSystemChannel(channel, reason);
      break;
    case "verificationLevel":
      if (has("setVerificationLevel")) await guild.setVerificationLevel(entry.value, reason);
      break;
    case "explicitContentFilter":
      if (has("setExplicitContentFilter")) await guild.setExplicitContentFilter(entry.value, reason);
      break;
    case "defaultNotifications":
      if (has("setDefaultMessageNotifications")) {
        await guild.setDefaultMessageNotifications(entry.value, reason);
      }
      break;
    default:
      throw new Error(`unknown setting “${entry.key}”`);
  }

  report.settingsApplied += 1;
}

/**
 * Execute a plan against a live target guild.
 * Each unit of work is its own step so one failure (a missing permission, a
 * rate limit) doesn't abort the whole replication.
 */
export async function applyPlan({
  plan,
  sourceGuild,
  targetGuild,
  options = {},
  onProgress = () => {},
}) {
  const reason = options.reason ?? "Server replication";
  const delayMs = options.delayMs ?? 300;
  const readOnly = options.readOnly ?? true;

  // A preview server is for looking, not talking: every channel gets an
  // @everyone overwrite that keeps it readable but silent.
  const finalOverwrites = (overwrites) =>
    readOnly ? readOnlyOverwrites(overwrites, targetGuild.id) : overwrites;

  const report = {
    rolesCreated: 0,
    rolesUpdated: 0,
    rolesReused: 0,
    channelsCreated: 0,
    channelsUpdated: 0,
    emojisCreated: 0,
    settingsApplied: 0,
    messagesCopied: 0,
    messagesSkipped: 0,
    skipped: [],
    warnings: [...plan.warnings],
    errors: [],
  };

  const roleMap = new Map([[plan.source.id, { id: targetGuild.id }]]);
  const channelMap = new Map();
  const memberCache = new Map();

  const steps = [];
  const addStep = (label, run) => steps.push({ label, run });

  // Roles first: channel permission overwrites reference them.
  for (const entry of plan.roles) {
    if (entry.action === "skip") {
      report.skipped.push(`Role “${entry.name}” — ${entry.reason}`);
      continue;
    }

    addStep(`role “${entry.name}”`, async () => {
      if (entry.action === "reuse") {
        const role = await resolveRole(targetGuild, entry.targetId);
        if (!role) throw new Error("the existing role disappeared");

        const edits = {};
        if ((role.color ?? 0) !== entry.color) edits.color = entry.color;
        if (Boolean(role.hoist) !== entry.hoist) edits.hoist = entry.hoist;
        if (Boolean(role.mentionable) !== entry.mentionable) edits.mentionable = entry.mentionable;
        if (String(role.permissions?.bitfield ?? 0n) !== entry.permissions) {
          edits.permissions = BigInt(entry.permissions);
        }

        if (Object.keys(edits).length) {
          await role.edit({ ...edits, reason });
          report.rolesUpdated += 1;
        } else {
          report.rolesReused += 1;
        }
        roleMap.set(entry.sourceId, role);
        return;
      }

      const role = await targetGuild.roles.create({
        name: entry.name,
        color: entry.color || undefined,
        hoist: entry.hoist,
        mentionable: entry.mentionable,
        permissions: BigInt(entry.permissions),
        unicodeEmoji: entry.unicodeEmoji ?? undefined,
        reason,
      });
      roleMap.set(entry.sourceId, role);
      report.rolesCreated += 1;
      await sleep(delayMs);
    });
  }

  addStep("role order", async () => {
    await syncRolePositions(targetGuild, plan, roleMap, report, reason);
  });

  // Categories, then their children.
  for (const entry of plan.categories) {
    addStep(`category “${entry.name}”`, async () => {
      const overwrites = finalOverwrites(
        await buildOverwrites(entry, roleMap, targetGuild, memberCache, report),
      );

      if (entry.action === "reuse") {
        const channel = await resolveChannel(targetGuild, entry.targetId);
        if (!channel) throw new Error("the existing category disappeared");
        await channel.permissionOverwrites.set(overwrites, reason);
        channelMap.set(entry.sourceId, channel);
        report.channelsUpdated += 1;
        return;
      }

      const channel = await targetGuild.channels.create({
        ...channelCreatePayload(entry, null, overwrites),
        reason,
      });
      channelMap.set(entry.sourceId, channel);
      report.channelsCreated += 1;
      await sleep(delayMs);
    });
  }

  for (const entry of plan.channels) {
    addStep(`#${entry.name}`, async () => {
      const parent = entry.parentSourceId ? channelMap.get(entry.parentSourceId) ?? null : null;
      const overwrites = finalOverwrites(
        await buildOverwrites(entry, roleMap, targetGuild, memberCache, report),
      );

      if (entry.action === "reuse") {
        const channel = await resolveChannel(targetGuild, entry.targetId);
        if (!channel) throw new Error("the existing channel disappeared");

        const edits = { reason };
        for (const field of CHANNEL_SETTING_FIELDS) {
          if (entry[field] === undefined || entry[field] === null) continue;
          if (channel[field] !== entry[field]) edits[field] = entry[field];
        }
        if (Object.keys(edits).length > 1) await channel.edit(edits);
        if (typeof channel.permissionOverwrites?.set === "function") {
          await channel.permissionOverwrites.set(overwrites, reason);
        }

        channelMap.set(entry.sourceId, channel);
        report.channelsUpdated += 1;
        return;
      }

      const channel = await targetGuild.channels.create({
        ...channelCreatePayload(entry, parent, overwrites),
        reason,
      });
      channelMap.set(entry.sourceId, channel);
      report.channelsCreated += 1;
      await sleep(delayMs);
    });
  }

  addStep("channel order", async () => {
    for (const entry of [...plan.categories, ...plan.channels]) {
      const channel = channelMap.get(entry.sourceId);
      if (!channel || typeof channel.setPosition !== "function") continue;
      if (channel.position === entry.position) continue;
      try {
        await channel.setPosition(entry.position, reason);
      } catch (error) {
        report.warnings.push(`Couldn't move #${entry.name}: ${describeError(error)}`);
      }
    }
  });

  // Emojis.
  let emojiSlotsReported = false;
  for (const entry of plan.emojis) {
    if (entry.action === "skip") {
      report.skipped.push(`Emoji :${entry.name}: — ${entry.reason}`);
      continue;
    }

    addStep(`emoji :${entry.name}:`, async () => {
      const used = targetGuild.emojis?.cache?.size ?? 0;
      if (used >= EMOJI_SLOTS) {
        if (!emojiSlotsReported) {
          report.warnings.push(
            "No emoji slots were left in the target server, so emojis were skipped.",
          );
          emojiSlotsReported = true;
        }
        return;
      }

      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_EMOJI_BYTES) throw new Error("the file is larger than 256 KB");

      await targetGuild.emojis.create({ attachment: buffer, name: entry.name, reason });
      report.emojisCreated += 1;
      await sleep(delayMs);
    });
  }

  // Recent messages, after every channel exists.
  for (const entry of plan.channels) {
    if (!entry.messages) continue;

    addStep(`messages in #${entry.name}`, async () => {
      const sourceChannel = sourceGuild?.channels?.cache?.get(entry.sourceId);
      const targetChannel = channelMap.get(entry.sourceId);
      if (!sourceChannel || !targetChannel) return;

      const result = await copyChannelMessages({
        sourceChannel,
        targetChannel,
        limit: entry.messages,
        reason,
      });
      report.messagesCopied += result.copied;
      report.messagesSkipped += result.skipped;
      if (result.error) report.warnings.push(`#${entry.name}: ${result.error}`);
    });
  }

  // Server settings last: renaming or moving the system channel mid-run is noisy.
  for (const entry of plan.settings) {
    addStep(`setting: ${entry.label}`, async () => {
      await applySetting(entry, { guild: targetGuild, channelMap, report, reason });
    });
  }

  let done = 0;
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      report.errors.push(`${step.label}: ${describeError(error)}`);
    }
    done += 1;
    onProgress({ done, total: steps.length, label: step.label });
  }

  report.warnings = [...new Set(report.warnings)];
  return report;
}
