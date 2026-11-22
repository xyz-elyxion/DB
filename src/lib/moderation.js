import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { MAX_TIMEOUT_MS, formatDuration, parseDuration } from "./duration.js";
import { parseInviteCode } from "./invites.js";
import { UserError, describeError } from "./errors.js";

const DAY = 86_400_000;
const MAX_PURGE = 100;
const REASON_LIMIT = 512;

/** What each command needs, re-checked here because Discord only hides the command. */
const GUARDS = {
  ban: { bit: PermissionFlagsBits.BanMembers, label: "Ban Members" },
  unban: { bit: PermissionFlagsBits.BanMembers, label: "Ban Members" },
  kick: { bit: PermissionFlagsBits.KickMembers, label: "Kick Members" },
  timeout: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  untimeout: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  warn: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  warnings: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  clearwarnings: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  case: { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  "create-invite": { bit: PermissionFlagsBits.CreateInstantInvite, label: "Create Invite" },
  "remove-invite": { bit: PermissionFlagsBits.CreateInstantInvite, label: "Create Invite" },
  "block-join": { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  "unblock-join": { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  "blocked-joins": { bit: PermissionFlagsBits.ModerateMembers, label: "Moderate Members" },
  purge: { bit: PermissionFlagsBits.ManageMessages, label: "Manage Messages" },
  slowmode: { bit: PermissionFlagsBits.ManageChannels, label: "Manage Channels" },
  lock: { bit: PermissionFlagsBits.ManageChannels, label: "Manage Channels" },
  unlock: { bit: PermissionFlagsBits.ManageChannels, label: "Manage Channels" },
};

const COLORS = {
  ban: 0xed4245,
  unban: 0x57f287,
  kick: 0xe67e22,
  timeout: 0xfee75c,
  untimeout: 0x57f287,
  warn: 0xfee75c,
  clearwarnings: 0x57f287,
  purge: 0xeb459e,
  lock: 0x99aab5,
  unlock: 0x57f287,
  slowmode: 0x5865f2,
  invite: 0x57f287,
  "remove-invite": 0xed4245,
  "block-join": 0xed4245,
  "unblock-join": 0x57f287,
};

const memberOption = (option) =>
  option.setName("member").setDescription("Who to act on").setRequired(true);

const reasonOption = (option, required = false) =>
  option
    .setName("reason")
    .setDescription("Why — kept on the case and in the log")
    .setMaxLength(REASON_LIMIT)
    .setRequired(required);

export const MOD_COMMANDS = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban someone from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(memberOption)
    .addStringOption((option) => reasonOption(option))
    .addIntegerOption((option) =>
      option
        .setName("delete_days")
        .setDescription("Also delete their messages from this many days back (0–7)")
        .setMinValue(0)
        .setMaxValue(7),
    ),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Lift a ban by user ID.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("Their user ID (right-click → Copy User ID)")
        .setRequired(true),
    )
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick someone from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(memberOption)
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Stop someone from talking for a while.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(memberOption)
    .addStringOption((option) =>
      option
        .setName("duration")
        .setDescription("How long — 10m, 2h, 1d (max 28d)")
        .setRequired(true),
    )
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("End someone's timeout early.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(memberOption)
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn someone and keep it on their record.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(memberOption)
    .addStringOption((option) => reasonOption(option, true)),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show someone's warnings.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(memberOption),
  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Delete all of someone's warnings.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(memberOption),
  new SlashCommandBuilder()
    .setName("case")
    .setDescription("Show one moderation case.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((option) =>
      option.setName("id").setDescription("The case number").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("How many messages (1–100)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_PURGE),
    )
    .addUserOption((option) =>
      option.setName("member").setDescription("Only delete this member's messages"),
    ),
  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set the channel's slowmode.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) =>
      option
        .setName("seconds")
        .setDescription("Seconds between messages (0 turns it off)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Defaults to this channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Stop everyone from talking in a channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Defaults to this channel"),
    )
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Let everyone talk in a channel again.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Defaults to this channel"),
    )
    .addStringOption((option) => reasonOption(option)),
  new SlashCommandBuilder()
    .setName("create-invite")
    .setDescription("Create an invite to the preview server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.CreateInstantInvite)
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("Only this user may use it — anyone else who joins gets kicked"),
    ),
  new SlashCommandBuilder()
    .setName("remove-invite")
    .setDescription("Delete an invite to the preview server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.CreateInstantInvite)
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("The invite code or full link")
        .setRequired(true)
        .setMaxLength(120),
    ),
  new SlashCommandBuilder()
    .setName("block-join")
    .setDescription("Stop someone joining the real server from the preview.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((option) =>
      option.setName("user_id").setDescription("Their user ID").setRequired(true),
    )
    .addStringOption((option) => reasonOption(option, true)),
  new SlashCommandBuilder()
    .setName("unblock-join")
    .setDescription("Let someone join from the preview again.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((option) =>
      option.setName("user_id").setDescription("Their user ID").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("blocked-joins")
    .setDescription("List everyone blocked from joining via the preview.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
];

function cleanReason(value) {
  const text = (value ?? "").trim();
  return text ? text.slice(0, REASON_LIMIT) : "No reason given";
}

function readUserId(value) {
  const userId = String(value ?? "").replace(/[<@!>]/g, "").trim();
  if (!/^\d{16,20}$/.test(userId)) {
    throw new UserError(
      "That isn't a user ID. Turn on Developer Mode, right-click the person → **Copy User ID**.",
    );
  }
  return userId;
}

function tagOf(user) {
  return user?.tag ?? user?.username ?? user?.id ?? "that user";
}

function requirePermission(member, guard) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(guard.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${guard.label}** permission for that.`);
}

/**
 * Refuse the moderation actions Discord would refuse anyway, with a message
 * that explains why. The server owner outranks everyone; nobody outranks the
 * bot, so the bot's own role position is checked too.
 */
export function assertCanModerate({ guild, moderator, target, action }) {
  if (!target) throw new UserError("I can't find that member in the server.");
  if (target.id === moderator.id) throw new UserError(`You can't ${action} yourself.`);
  if (target.id === guild.ownerId) throw new UserError("The server owner can't be moderated.");
  if (target.id === guild.members?.me?.id) throw new UserError(`I can't ${action} myself.`);

  const targetTop = target.roles?.highest?.position ?? 0;
  const moderatorTop = moderator.roles?.highest?.position ?? 0;
  const moderatorIsOwner = moderator.id === guild.ownerId;

  if (!moderatorIsOwner && targetTop >= moderatorTop) {
    throw new UserError(
      `**${tagOf(target.user)}**'s top role is the same as or above yours, so you can't ${action} them.`,
    );
  }

  const botTop = guild.members?.me?.roles?.highest?.position ?? 0;
  if (guild.members?.me && targetTop >= botTop) {
    throw new UserError(
      `My role sits below **${tagOf(target.user)}**'s, so Discord won't let me ${action} them. ` +
        "Move my role higher in Server Settings → Roles.",
    );
  }
}

/** Messages Discord can still bulk delete: recent ones, optionally from one author. */
export function selectPurgeable(messages, { amount = MAX_PURGE, userId = null, now = Date.now() } = {}) {
  const cutoff = now - 14 * DAY;
  return messages
    .filter(
      (message) =>
        (message.createdTimestamp ?? 0) > cutoff && (userId === null || message.author?.id === userId),
    )
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .slice(0, Math.min(amount, MAX_PURGE));
}

async function fetchMember(guild, id) {
  return guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
}

export function caseEmbed(record) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[record.type] ?? 0x5865f2)
    .setTitle(`Case #${record.id} — ${record.type}`)
    .setTimestamp(record.at ? new Date(record.at) : new Date())
    .setFooter({ text: `Case #${record.id}` });

  const target = record.targetId
    ? `<@${record.targetId}>`
    : record.channelId
      ? `<#${record.channelId}>`
      : "—";

  embed.addFields(
    { name: "Target", value: target, inline: true },
    { name: "Moderator", value: record.moderatorId ? `<@${record.moderatorId}>` : "—", inline: true },
    { name: "Reason", value: record.reason || "No reason given" },
  );

  return embed;
}

function caseText(record) {
  const target = record.targetId
    ? `<@${record.targetId}>`
    : record.channelId
      ? `<#${record.channelId}>`
      : "server";
  return `\`#${record.id}\` • **${record.type}** • ${target} • <@${record.moderatorId}> • ${record.reason}`;
}

async function sendLog(guild, logChannelId, record) {
  const channel = logChannelId
    ? await guild.channels.fetch(logChannelId).catch(() => null)
    : ([...guild.channels.cache.values()].find(
        (candidate) => candidate.name === "mod-logs" && candidate.type === ChannelType.GuildText,
      ) ?? null);

  if (typeof channel?.send !== "function") return;

  await channel.send({ embeds: [caseEmbed(record)] }).catch(() => {});
}

const HANDLERS = {
  async ban({ guild, moderator, options }) {
    const user = options.getUser("member", true);
    const reason = cleanReason(options.getString("reason"));
    const deleteDays = options.getInteger("delete_days") ?? 0;

    const target = await fetchMember(guild, user.id);
    if (target) assertCanModerate({ guild, moderator, target, action: "ban" });

    await guild.members.ban(user.id, {
      reason,
      deleteMessageSeconds: deleteDays * 86_400,
    });

    return {
      message:
        `🔨 Banned **${tagOf(user)}**.` +
        (deleteDays ? `\nDeleted their messages from the last ${deleteDays} day(s).` : "") +
        `\nReason: ${reason}`,
      caseData: { type: "ban", targetId: user.id, targetTag: tagOf(user), reason },
    };
  },

  async unban({ guild, options }) {
    const userId = readUserId(options.getString("user_id", true));
    const reason = cleanReason(options.getString("reason"));
    try {
      await guild.bans.remove(userId, reason);
    } catch (error) {
      if (error?.code === 10026) throw new UserError("That user isn't banned.");
      throw error;
    }

    return {
      message: `✅ Unbanned <@${userId}>.\nReason: ${reason}`,
      caseData: { type: "unban", targetId: userId, reason },
    };
  },

  async kick({ guild, moderator, options }) {
    const user = options.getUser("member", true);
    const reason = cleanReason(options.getString("reason"));
    const target = await fetchMember(guild, user.id);
    if (!target) throw new UserError("That member isn't in the server.");

    assertCanModerate({ guild, moderator, target, action: "kick" });
    await target.kick(reason);

    return {
      message: `👢 Kicked **${tagOf(user)}**.\nReason: ${reason}`,
      caseData: { type: "kick", targetId: user.id, targetTag: tagOf(user), reason },
    };
  },

  async timeout({ guild, moderator, options }) {
    const user = options.getUser("member", true);
    const reason = cleanReason(options.getString("reason"));
    const ms = parseDuration(options.getString("duration", true));
    if (!ms) throw new UserError("Give a duration like `10m`, `2h` or `1d`.");
    if (ms > MAX_TIMEOUT_MS) throw new UserError("Discord caps timeouts at 28 days.");

    const target = await fetchMember(guild, user.id);
    if (!target) throw new UserError("That member isn't in the server.");

    assertCanModerate({ guild, moderator, target, action: "timeout" });
    await target.timeout(ms, reason);

    return {
      message: `🔇 Timed out **${tagOf(user)}** for ${formatDuration(ms)}.\nReason: ${reason}`,
      caseData: { type: "timeout", targetId: user.id, targetTag: tagOf(user), reason, durationMs: ms },
    };
  },

  async untimeout({ guild, moderator, options }) {
    const user = options.getUser("member", true);
    const reason = cleanReason(options.getString("reason"));
    const target = await fetchMember(guild, user.id);
    if (!target) throw new UserError("That member isn't in the server.");

    assertCanModerate({ guild, moderator, target, action: "untimeout" });
    await target.timeout(null, reason);

    return {
      message: `🔊 Removed the timeout from **${tagOf(user)}**.`,
      caseData: { type: "untimeout", targetId: user.id, reason },
    };
  },

  async warn({ guild, moderator, options, cases }) {
    const user = options.getUser("member", true);
    const reason = cleanReason(options.getString("reason"));
    const target = await fetchMember(guild, user.id);
    if (!target) throw new UserError("That member isn't in the server.");

    assertCanModerate({ guild, moderator, target, action: "warn" });

    const count = cases.forUser(guild.id, user.id, "warn").length + 1;

    return {
      message: `⚠️ Warned **${tagOf(user)}** — that's warning ${count}.\nReason: ${reason}`,
      caseData: { type: "warn", targetId: user.id, targetTag: tagOf(user), reason },
    };
  },

  async warnings({ guild, options, cases }) {
    const user = options.getUser("member");
    if (!user) throw new UserError("Pick a member to look up.");

    const records = cases.forUser(guild.id, user.id, "warn");
    if (records.length === 0) return { message: `**${tagOf(user)}** has no warnings.` };

    const lines = records.slice(-10).map(caseText);
    const extra = records.length > 10 ? `\n…and ${records.length - 10} older.` : "";

    return {
      message: `**${tagOf(user)}** has ${records.length} warning(s):\n${lines.join("\n")}${extra}`.slice(
        0,
        1900,
      ),
    };
  },

  async clearwarnings({ guild, options, cases }) {
    const user = options.getUser("member");
    if (!user) throw new UserError("Pick a member first.");

    const removed = cases.clearForUser(guild.id, user.id, "warn");
    if (removed === 0) return { message: `**${tagOf(user)}** had no warnings to clear.` };

    return {
      message: `🧽 Cleared ${removed} warning(s) for **${tagOf(user)}**.`,
      caseData: { type: "clearwarnings", targetId: user.id, reason: `Cleared ${removed} warning(s)` },
    };
  },

  async case({ guild, options, cases }) {
    const id = options.getInteger("id", true);
    const record = cases.get(guild.id, id);
    if (!record) throw new UserError(`There's no case #${id}.`);

    return { message: `${caseText(record)}\n<t:${Math.floor(Date.parse(record.at) / 1000)}:f>` };
  },

  async purge({ interaction, options }) {
    const channel = interaction.channel;
    if (typeof channel?.messages?.fetch !== "function") {
      throw new UserError("Run this in a text channel.");
    }

    const amount = options.getInteger("amount", true);
    const user = options.getUser("member");

    const fetched = await channel.messages.fetch({ limit: MAX_PURGE });
    const targets = selectPurgeable([...fetched.values()], { amount, userId: user?.id ?? null });
    if (targets.length === 0) {
      throw new UserError("Nothing to delete — messages older than 14 days can't be bulk deleted.");
    }

    const deleted = await channel.bulkDelete(targets, true);

    return {
      message:
        `🧹 Deleted **${deleted.size}** message(s)` +
        (user ? ` from **${tagOf(user)}**` : "") +
        ".",
      caseData: {
        type: "purge",
        targetId: user?.id ?? null,
        reason: `${deleted.size} message(s) in #${channel.name ?? channel.id}`,
      },
    };
  },

  async slowmode({ interaction, options }) {
    const channel = options.getChannel("channel") ?? interaction.channel;
    if (typeof channel?.setRateLimitPerUser !== "function") {
      throw new UserError("Pick a text channel I can edit.");
    }

    const seconds = options.getInteger("seconds", true);
    await channel.setRateLimitPerUser(seconds, "Slowmode command");

    return {
      message: seconds
        ? `🐌 Slowmode in <#${channel.id}> is now ${formatDuration(seconds * 1000)}.`
        : `🐌 Slowmode is off in <#${channel.id}>.`,
      caseData: { type: "slowmode", channelId: channel.id, reason: `${seconds}s` },
    };
  },

  async lock({ guild, interaction, options }) {
    const channel = options.getChannel("channel") ?? interaction.channel;
    if (typeof channel?.permissionOverwrites?.edit !== "function") {
      throw new UserError("Pick a channel I can edit.");
    }

    const reason = cleanReason(options.getString("reason"));
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      {
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      },
      { reason },
    );

    return {
      message: `🔒 Locked <#${channel.id}> — only staff can talk there now.`,
      caseData: { type: "lock", channelId: channel.id, reason },
    };
  },

  async unlock({ guild, interaction, options }) {
    const channel = options.getChannel("channel") ?? interaction.channel;
    if (typeof channel?.permissionOverwrites?.edit !== "function") {
      throw new UserError("Pick a channel I can edit.");
    }

    const reason = cleanReason(options.getString("reason"));
    // null removes the overwrite, so the channel follows its normal permissions again.
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      {
        SendMessages: null,
        SendMessagesInThreads: null,
        CreatePublicThreads: null,
        CreatePrivateThreads: null,
      },
      { reason },
    );

    return {
      message: `🔓 Unlocked <#${channel.id}>.`,
      caseData: { type: "unlock", channelId: channel.id, reason },
    };
  },

  async "create-invite"({ moderator, options, previewGuild, invites }) {
    if (!previewGuild) {
      throw new UserError("I'm not in the preview server, so I can't create an invite there.");
    }
    if (!invites) throw new UserError("Invite tracking isn't running, so I can't make one safely.");

    const raw = options.getString("user_id");
    const userId = raw ? raw.replace(/[<@!>]/g, "").trim() : null;
    if (raw && !/^\d{16,20}$/.test(userId)) {
      throw new UserError(
        "That isn't a user ID. Turn on Developer Mode, right-click the person → **Copy User ID**.",
      );
    }

    const { record } = await invites.createLocked({
      guild: previewGuild,
      userId,
      inviterId: moderator.id,
      reason: userId ? `Preview invite for ${userId}` : "Preview invite",
    });

    const lines = [
      `🎟️ Single-use invite to **${previewGuild.name}**, valid for 7 days:`,
      record.url,
    ];

    if (userId) {
      lines.push(
        "",
        `It only works for <@${userId}>. If anyone else joins with it, they are kicked and the invite is deleted.`,
      );
    } else {
      lines.push("", "Anyone who has the link can use it once.");
    }

    return {
      message: lines.join("\n"),
      caseData: {
        type: "invite",
        targetId: userId,
        reason: userId
          ? `Personal preview invite (${record.code})`
          : `Preview invite (${record.code})`,
      },
    };
  },

  async "remove-invite"({ moderator, options, previewGuild, invites }) {
    if (!previewGuild) {
      throw new UserError("I'm not in the preview server, so I can't remove an invite there.");
    }
    if (!invites) throw new UserError("Invite tracking isn't running, so I can't remove one safely.");

    const code = parseInviteCode(options.getString("code", true));
    if (!code) throw new UserError("Give me an invite code or link to remove.");

    const result = await invites.remove({
      guild: previewGuild,
      code,
      reason: `Invite removed by ${moderator.id}`,
    });

    return {
      message:
        `🗑️ Removed the invite \`${code}\`` +
        (result.userId ? ` that was made for <@${result.userId}>` : "") +
        ".",
      caseData: {
        type: "remove-invite",
        targetId: result.userId,
        reason: `Removed invite ${code}`,
      },
    };
  },

  async "block-join"({ guild, moderator, options, joinBlocks }) {
    if (!joinBlocks) throw new UserError("Join blocking isn't running, so I can't save this.");

    const userId = readUserId(options.getString("user_id", true));
    const reason = cleanReason(options.getString("reason"));

    joinBlocks.block({
      guildId: guild.id,
      userId,
      reason,
      moderatorId: moderator.id,
    });

    return {
      message:
        `🚫 <@${userId}> can no longer join **${guild.name}** from the preview.\n` +
        `Reason: ${reason}`,
      caseData: { type: "block-join", targetId: userId, reason },
    };
  },

  async "unblock-join"({ guild, options, joinBlocks }) {
    if (!joinBlocks) throw new UserError("Join blocking isn't running.");

    const userId = readUserId(options.getString("user_id", true));
    if (!joinBlocks.lift(guild.id, userId)) {
      throw new UserError(`<@${userId}> isn't blocked from joining.`);
    }

    return {
      message: `✅ <@${userId}> can join **${guild.name}** from the preview again.`,
      caseData: { type: "unblock-join", targetId: userId, reason: "Block lifted" },
    };
  },

  async "blocked-joins"({ guild, joinBlocks }) {
    if (!joinBlocks) throw new UserError("Join blocking isn't running.");

    const blocks = joinBlocks.list(guild.id);
    if (blocks.length === 0) return { message: "Nobody is blocked from joining." };

    const lines = blocks.slice(-15).map((entry) => `<@${entry.userId}> — ${entry.reason}`);
    const extra = blocks.length > 15 ? `\n…and ${blocks.length - 15} more.` : "";

    return {
      message: `🚫 **${blocks.length}** blocked from joining:\n${lines.join("\n")}${extra}`.slice(
        0,
        1900,
      ),
    };
  },
};

/**
 * Run one slash command from the main server. Replies are ephemeral, every
 * action that leaves a trace is stored as a case and posted to the mod log.
 * Returns false when the command isn't ours.
 */
export async function runModerationCommand(interaction, context = {}) {
  const { cases, logChannelId = null } = context;
  const name = interaction.commandName;
  const handler = HANDLERS[name];
  if (!handler) return false;

  const guild = interaction.guild;
  const moderator = interaction.member;

  try {
    if (!guild) throw new UserError("Moderation commands only work inside a server.");
    requirePermission(moderator, GUARDS[name]);

    const result = await handler({
      interaction,
      guild,
      moderator,
      options: interaction.options,
      ...context,
    });

    const record = result.caseData
      ? cases.add({ guildId: guild.id, moderatorId: moderator.id, ...result.caseData })
      : null;

    await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
    if (record) await sendLog(guild, logChannelId, record);
  } catch (error) {
    const message =
      error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
    await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return true;
}
