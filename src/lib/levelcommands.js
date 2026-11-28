import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { COLORS, leaderboardCard, panelCard, rankCard } from "./embeds.js";
import { UserError, describeError } from "./errors.js";
import { MAX_LEVEL, progressBar } from "./levels.js";

/** Management commands need Manage Server; /rank and /leaderboard need nothing. */
const GUARDS = {
  "level-xp": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "set-level": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "reset-xp": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "level-settings": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "level-toggle": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "level-announce": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "no-xp-channel": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "level-role": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
  "level-rewards": { bit: PermissionFlagsBits.ManageGuild, label: "Manage Server" },
};

function who(option) {
  return option.setName("member").setDescription("Who").setRequired(false);
}

function number(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

export const LEVEL_COMMANDS = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show your level, XP and rank — or someone else's.")
    .addUserOption(who)
    .addBooleanOption((option) =>
      option.setName("public").setDescription("Show it to everyone instead of just you"),
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("The members with the most XP.")
    .addIntegerOption((option) =>
      option.setName("page").setDescription("Which page (10 per page)").setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName("level-xp")
    .setDescription("Give or take XP (negative amounts take it away).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) => option.setName("member").setDescription("Who").setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("XP to add — negative to remove")
        .setRequired(true)
        .setMinValue(-1_000_000)
        .setMaxValue(1_000_000),
    ),
  new SlashCommandBuilder()
    .setName("set-level")
    .setDescription("Put someone at an exact level.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) => option.setName("member").setDescription("Who").setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription("The level they should be")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(MAX_LEVEL),
    ),
  new SlashCommandBuilder()
    .setName("reset-xp")
    .setDescription("Wipe someone's XP and message count.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) => option.setName("member").setDescription("Who").setRequired(true)),
  new SlashCommandBuilder()
    .setName("level-settings")
    .setDescription("How leveling is set up on this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("level-toggle")
    .setDescription("Turn levelling on or off.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("On or off — leave empty to flip it"),
    ),
  new SlashCommandBuilder()
    .setName("level-announce")
    .setDescription("Pick where level-up messages go — leave the channel empty to turn them off.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Where to announce — omit to announce in the chat channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  new SlashCommandBuilder()
    .setName("no-xp-channel")
    .setDescription("Stop a channel from giving XP.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel to toggle")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  new SlashCommandBuilder()
    .setName("level-role")
    .setDescription("Give a role at a level — leave the role empty to remove the reward.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) =>
      option
        .setName("level")
        .setDescription("The level that unlocks it")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_LEVEL),
    )
    .addRoleOption((option) => option.setName("role").setDescription("The role to hand out")),
  new SlashCommandBuilder()
    .setName("level-rewards")
    .setDescription("Which roles unlock at which levels.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

const HANDLERS = {
  async rank({ guild, moderator, options, levels }) {
    const user = options.getUser("member") ?? moderator.user ?? { id: moderator.id };
    const stats = levels.get(guild.id, user.id);
    const position = levels.rank(guild.id, user.id);
    const name = user.tag ?? user.username ?? user.id;

    const embed = rankCard({
      name,
      level: stats.level,
      rank: position ? `#${position} of ${levels.count(guild.id)}` : "Unranked",
      xp: number(stats.xp),
      messages: number(stats.messages),
      progress: `${progressBar(stats.percent)}  ${number(stats.into)} / ${number(stats.need)} XP`,
      footer: `${stats.percent}% of the way to the next level`,
    });

    return { embeds: [embed] };
  },

  async leaderboard({ guild, options, levels }) {
    const board = levels.leaderboard(guild.id, { page: options.getInteger("page") ?? 1 });
    if (board.total === 0) {
      return { content: "Nobody has earned XP yet — start talking!" };
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = board.entries.map(
      (entry) =>
        `${medals[entry.rank - 1] ?? `**${entry.rank}.**`} <@${entry.userId}> — ` +
        `level ${entry.level}, ${number(entry.xp)} XP`,
    );

    const embed = leaderboardCard({
      page: board.page,
      pages: board.pages,
      lines: lines.join("\n"),
      footer: `${board.total} member(s) ranked`,
    });

    return { embeds: [embed] };
  },

  async "level-xp"({ guild, options, levels, syncRewards }) {
    const user = options.getUser("member", true);
    const amount = options.getInteger("amount", true);
    if (amount === 0) throw new UserError("That would change nothing.");

    const result = levels.addXp({ guildId: guild.id, userId: user.id, amount });
    if (result.leveledUp) await syncRewards?.(guild, user.id, result.level);

    return {
      message:
        `${amount > 0 ? "➕" : "➖"} Gave **${Math.abs(amount)}** XP to <@${user.id}> — ` +
        `now level **${result.level}** (${number(result.xp)} XP).` +
        (result.leveledUp ? "\nThey levelled up — role rewards unlocked." : ""),
      caseData: {
        type: "level-xp",
        targetId: user.id,
        reason: `${amount > 0 ? "+" : ""}${amount} XP`,
      },
    };
  },

  async "set-level"({ guild, options, levels, syncRewards }) {
    const user = options.getUser("member", true);
    const level = options.getInteger("level", true);
    const result = levels.setLevel({ guildId: guild.id, userId: user.id, level });
    await syncRewards?.(guild, user.id, result.level);

    return {
      message: `📊 <@${user.id}> is now **level ${result.level}** (${number(result.xp)} XP).`,
      caseData: { type: "set-level", targetId: user.id, reason: `Level ${result.level}` },
    };
  },

  async "reset-xp"({ guild, options, levels }) {
    const user = options.getUser("member", true);
    const existed = levels.reset(guild.id, user.id);

    return {
      message: existed
        ? `🧽 Reset the XP of <@${user.id}>.`
        : `<@${user.id}> had no XP to reset.`,
      caseData: existed ? { type: "reset-xp", targetId: user.id, reason: "XP reset" } : null,
    };
  },

  async "level-settings"({ guild, levels }) {
    const settings = levels.settings(guild.id);
    const rewards = Object.entries(settings.roleRewards).sort(([a], [b]) => Number(a) - Number(b));

    const embed = panelCard({
      colour: COLORS.rank,
      title: "⚙️ Level settings",
      fields: [
        { name: "Levelling", value: settings.enabled ? "On" : "Off", inline: true },
        {
          name: "Level-up messages",
          value: settings.announceChannelId ? `<#${settings.announceChannelId}>` : "In the channel where it happened",
          inline: true,
        },
        {
          name: "XP per message",
          value: `${levels.xpRange.min}–${levels.xpRange.max} XP, once per ${Math.round(levels.cooldownMs / 1000)}s`,
        },
        {
          name: "No-XP channels",
          value: settings.noXpChannels.length
            ? settings.noXpChannels.map((id) => `<#${id}>`).join(", ")
            : "None",
        },
        {
          name: "Role rewards",
          value: rewards.length
            ? rewards.map(([level, roleId]) => `Level ${level} → <@&${roleId}>`).join("\n")
            : "None",
        },
      ],
    });

    return { embeds: [embed] };
  },

  async "level-toggle"({ guild, options, levels }) {
    const current = levels.settings(guild.id).enabled;
    const wanted = options.getBoolean("enabled");
    const enabled = levels.setEnabled(guild.id, wanted ?? !current).enabled;

    return {
      message: enabled
        ? "✅ Levelling is on — messages earn XP again."
        : "⏸️ Levelling is off — messages no longer earn XP (levels are kept).",
      caseData: { type: "level-toggle", reason: enabled ? "Levelling on" : "Levelling off" },
    };
  },

  async "level-announce"({ guild, options, levels }) {
    const channel = options.getChannel("channel");
    if (!channel) {
      levels.setAnnounceChannel(guild.id, null);
      return {
        message: "🔕 Level-up messages will no longer be posted.",
        caseData: { type: "level-announce", reason: "Announcements off" },
      };
    }

    levels.setAnnounceChannel(guild.id, channel.id);
    return {
      message: `📣 Level-up messages will be posted in <#${channel.id}>.`,
      caseData: { type: "level-announce", channelId: channel.id, reason: "Announcements on" },
    };
  },

  async "no-xp-channel"({ guild, options, levels }) {
    const channel = options.getChannel("channel", true);
    const result = levels.toggleNoXpChannel(guild.id, channel.id);

    return {
      message: result.enabled
        ? `🚫 <#${channel.id}> no longer gives XP.`
        : `✅ <#${channel.id}> gives XP again.`,
      caseData: {
        type: "no-xp-channel",
        channelId: channel.id,
        reason: result.enabled ? "XP off" : "XP on",
      },
    };
  },

  async "level-role"({ guild, options, levels }) {
    const level = options.getInteger("level", true);
    const role = options.getRole("role");

    if (!role) {
      const before = levels.settings(guild.id).roleRewards[level];
      if (!before) throw new UserError(`No role is unlocked at level ${level}.`);
      levels.setRoleReward(guild.id, level, null);
      return {
        message: `🗑️ Removed the level ${level} role reward.`,
        caseData: { type: "level-role", targetId: before, reason: `Removed level ${level} reward` },
      };
    }

    const reward = levels.setRoleReward(guild.id, level, role.id);
    const rewards = Object.entries(reward)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([rewardLevel, roleId]) => `Level ${rewardLevel} → <@&${roleId}>`);

    return {
      message: `🎁 Reaching **level ${level}** now gives <@&${role.id}>.\n\n${rewards.join("\n")}`,
      caseData: { type: "level-role", targetId: role.id, reason: `Level ${level} reward` },
    };
  },

  async "level-rewards"({ guild, levels }) {
    const rewards = Object.entries(levels.settings(guild.id).roleRewards).sort(
      ([a], [b]) => Number(a) - Number(b),
    );
    if (rewards.length === 0) {
      return { message: "No role rewards yet — add one with `/level-role`." };
    }

    const lines = rewards.map(([level, roleId]) => `**Level ${level}** → <@&${roleId}>`);
    return { message: `🎁 Role rewards:\n${lines.join("\n")}`.slice(0, 1900) };
  },
};

function requirePermission(member, guard) {
  const permissions = member?.permissions;
  const allowed =
    typeof permissions?.has === "function" ? permissions.has(guard.bit) : Boolean(permissions);
  if (!allowed) throw new UserError(`You need the **${guard.label}** permission for that.`);
}

/**
 * Run one leveling command. Returns false when the command isn't ours, so the
 * moderation handler can try next. Replies are private unless `public: true`.
 */
export async function runLevelCommand(interaction, context = {}) {
  const name = interaction.commandName;
  const handler = HANDLERS[name];
  if (!handler) return false;

  const guild = interaction.guild;
  const moderator = interaction.member;
  const { levels } = context;

  try {
    if (!guild) throw new UserError("Level commands only work inside a server.");
    if (!levels) throw new UserError("Levelling isn't running.");

    const guard = GUARDS[name];
    if (guard) requirePermission(moderator, guard);

    const result = await handler({
      interaction,
      guild,
      moderator,
      options: interaction.options,
      levels,
      ...context,
    });

    const publicReply = interaction.options?.getBoolean?.("public") === true;
    const { message, caseData, ...rest } = result;

    await interaction.reply({
      ...(message ? { content: message } : {}),
      ...rest,
      ...(publicReply ? {} : { flags: MessageFlags.Ephemeral }),
    });

    if (caseData && context.cases) {
      const record = context.cases.add({
        guildId: guild.id,
        moderatorId: moderator.id,
        ...caseData,
      });
      context.onCase?.(record);
    }
  } catch (error) {
    const text = error instanceof UserError ? error.message : `That failed — ${describeError(error)}`;
    await interaction.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return true;
}
