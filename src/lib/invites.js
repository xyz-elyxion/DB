import { ChannelType } from "discord.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.js";
import { JOIN_CHANNEL_NAME } from "./join.js";

/** Locked invites last a week; they are single-use long before that. */
export const INVITE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Where a preview invite should land: the join channel, then rules/welcome. */
export function pickInviteChannel(guild) {
  const channels = [...(guild.channels?.cache?.values?.() ?? [])].filter(
    (channel) => channel.type === ChannelType.GuildText,
  );

  return (
    channels.find((channel) => channel.name === JOIN_CHANNEL_NAME) ??
    channels.find((channel) => channel.name === "welcome" || channel.name === "rules") ??
    channels[0] ??
    null
  );
}

/**
 * Invites into the preview that belong to one person.
 *
 * Discord never says which invite a new member used, so this compares the use
 * counts of the preview's invites before and after a join. A single-use invite
 * that the invited person used disappears; one that a stranger used is
 * attributed to that stranger, who is then kicked and the invite is deleted.
 */
export function createInviteGuard({ guildId, file = null } = {}) {
  const locked = new Map(); // code -> record
  const seen = new Map(); // code -> uses at the last snapshot

  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const record of parsed.locked ?? []) {
        if (record?.code) locked.set(record.code, record);
      }
    } catch (error) {
      console.warn(`Could not read ${file}, starting with no locked invites: ${error.message}`);
    }
  }

  function save() {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ locked: [...locked.values()] }, null, 2)}\n`);
    } catch (error) {
      console.error(`Could not save locked invites to ${file}: ${error.message}`);
    }
  }

  async function rememberUses(guild) {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;

    for (const invite of invites.values()) seen.set(invite.code, invite.uses ?? 0);
    for (const code of [...seen.keys()]) if (!invites.has(code)) seen.delete(code);

    return invites;
  }

  /** Snapshot the current invite counts so the next join can be attributed. */
  async function prime(guild) {
    if (!guild || guild.id !== guildId) return null;
    return rememberUses(guild);
  }

  async function createLocked({ guild, userId = null, inviterId = null, reason = "Preview invite" }) {
    if (!guild || guild.id !== guildId) {
      throw new UserError("I'm not in the preview server, so I can't create an invite there.");
    }

    const channel = pickInviteChannel(guild);
    if (!channel) {
      throw new UserError("There's no text channel in the preview to put the invite in.");
    }

    await rememberUses(guild);

    const invite = await guild.invites.create(channel, {
      maxUses: 1,
      maxAge: INVITE_MAX_AGE_SECONDS,
      unique: true,
      reason,
    });

    const record = {
      code: invite.code,
      url: invite.url ?? `https://discord.gg/${invite.code}`,
      userId,
      inviterId,
      channelId: channel.id,
      createdAt: new Date().toISOString(),
    };

    locked.set(invite.code, record);
    seen.set(invite.code, invite.uses ?? 0);
    save();

    return { invite, record };
  }

  async function handleJoin(member) {
    const guild = member.guild;
    if (!guild || guild.id !== guildId) return { action: "ignored" };

    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return { action: "unknown" };

    const used = [];
    for (const invite of invites.values()) {
      if ((invite.uses ?? 0) > (seen.get(invite.code) ?? 0)) used.push(invite.code);
    }

    // A used-up invite is gone from the guild, which is itself the signal.
    const vanished = [...locked.keys()].filter((code) => !invites.has(code));

    for (const invite of invites.values()) seen.set(invite.code, invite.uses ?? 0);
    for (const code of [...seen.keys()]) if (!invites.has(code)) seen.delete(code);

    const candidates = [...new Set([...used, ...vanished])].filter((code) => locked.has(code));
    if (candidates.length === 0) return { action: "ignored" };

    const matching = candidates.find((code) => locked.get(code).userId === member.id);
    if (matching) {
      locked.delete(matching);
      save();
      return { action: "allowed", code: matching };
    }

    // Somebody else used a personal invite: remove it and the member.
    const code = candidates[0];
    const record = locked.get(code);
    locked.delete(code);
    save();

    const invite = invites.get?.(code);
    if (invite && typeof invite.delete === "function") {
      await invite.delete("Invite was meant for another user").catch(() => {});
    }
    await member.kick("Joined with an invite meant for another user").catch(() => {});

    return { action: "kicked", code, expectedUserId: record.userId };
  }

  return {
    createLocked,
    handleJoin,
    prime,
    get pending() {
      return locked.size;
    },
  };
}
