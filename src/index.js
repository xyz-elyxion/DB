import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { assertConfig, config } from "./config.js";
import { applyPlan } from "./lib/builder.js";
import { createCaseStore } from "./lib/cases.js";
import { COUNTING_COMMANDS, runCountingCommand } from "./lib/countingcommands.js";
import { createCountingStore } from "./lib/counting.js";
import { createDaveAgent, daveEndpointHost } from "./lib/dave.js";
import { DAVE_COMMANDS, runDaveCommand } from "./lib/davecommands.js";
import { createDaveKeyStore } from "./lib/davekeys.js";
import { UserError } from "./lib/errors.js";
import { createInviteGuard } from "./lib/invites.js";
import { createJoinBlockStore } from "./lib/joinblocks.js";
import {
  createJoinFlow,
  ensureJoinChannel,
  resolveApplicationId,
  startJoinServer,
} from "./lib/join.js";
import { createLevelStore } from "./lib/levels.js";
import { LEVEL_COMMANDS, runLevelCommand } from "./lib/levelcommands.js";
import { createLiveSync } from "./lib/live.js";
import { MOD_COMMANDS, postCase, runModerationCommand } from "./lib/moderation.js";
import { planReplication } from "./lib/planner.js";
import { previewName } from "./lib/preview.js";
import { snapshotGuild } from "./lib/snapshot.js";
import { USER_COMMANDS, runUserCommand } from "./lib/usercommands.js";
import { createUserForum, syncExistingUserPosts } from "./lib/userposts.js";
import { createUserStore } from "./lib/users.js";

try {
  assertConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// GuildMessages powers XP even when message mirroring is off; MessageContent only
// controls whether the text itself is readable.
// Says exactly what this process read, because the Developer Portal toggle alone
// does nothing — the env var has to reach the running bot.
console.log(
  `Message mirroring: ${config.enableMessageContent ? "on" : "off"} ` +
    `(ENABLE_MESSAGE_CONTENT=${JSON.stringify(config.messageContentEnv)}).`,
);

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  // Dave also answers direct messages, where a one-time key is required.
  GatewayIntentBits.DirectMessages,
];
if (config.enableMessageContent) {
  intents.push(GatewayIntentBits.MessageContent);
}
if (config.enableMemberEvents) {
  intents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({ intents, partials: [Partials.Channel] });

// Slash commands are registered in these two servers and nowhere else, and an
// interaction from any other guild (or a DM) is refused.
const commandGuildIds = new Set([config.sourceId, config.targetId].filter(Boolean));
const live = createLiveSync({
  sourceId: config.sourceId,
  targetId: config.targetId,
  client,
  reason: "Server mirroring",
});

// Warnings and case numbers live on disk so they survive restarts.
const cases = createCaseStore({ file: config.casesFile });

// Personal preview invites, and the guard that kicks anyone who uses someone
// else's link.
const inviteGuard = createInviteGuard({ guildId: config.targetId, file: config.invitesFile });

// People who may stay in the preview but never join the real server.
const joinBlocks = createJoinBlockStore({ file: config.joinBlocksFile });

// XP and levels for the main server, persisted so ranks survive restarts.
const levels = createLevelStore({
  file: config.levelsFile,
  guildId: config.sourceId,
  minXp: config.xpMin,
  maxXp: config.xpMax,
  cooldownMs: config.xpCooldownSeconds * 1000,
});

// The counting channel, saved so a restart doesn't lose the chain.
const counting = createCountingStore({ file: config.countingFile, guildId: config.sourceId });

// Member records: names, emails, birthdays and the roles section, on disk.
const users = createUserStore({ file: config.usersFile });

// One-time keys let someone outside the servers ask Dave (/dave-key makes them).
const daveKeys = createDaveKeyStore({ file: config.daveKeysFile });

// Dave answers questions about the student database through an AI provider.
const dave = createDaveAgent({
  apiKey: config.daveApiKey,
  model: config.daveModel,
  endpoint: config.daveApiUrl,
  users,
  keys: daveKeys,
  sourceId: config.sourceId,
  guildIds: [config.sourceId, config.targetId],
});

// Every record also gets a post in the user forum, which follows the record.
const userForum = createUserForum({
  channelId: config.usersForumId,
  delayMs: config.forumPostDelayMs,
});

// Says where records live, so a wrong or unwritable path is obvious at a glance.
console.log(
  `User records: ${users.count(config.sourceId)} loaded from ${config.usersFile} ` +
    `(forum ${config.usersForumId ?? "off"}, ${config.forumPostDelayMs} ms between new posts).`,
);

console.log(
  dave.enabled
    ? `Dave: on (${config.daveModel} via ${daveEndpointHost(config.daveApiUrl)}), ` +
        `${daveKeys.count()} unused one-time key(s).`
    : "Dave: off — set DAVE_API_KEY (or HUGGINGFACE_API_KEY) to let people ask about the " +
        "student database.",
);

// The preview guild, once the bot has connected.
let previewGuild = null;

if (config.enableMemberEvents) {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild?.id !== config.targetId) return;

    try {
      const result = await inviteGuard.handleJoin(member);
      const who = member.user?.tag ?? member.id;

      if (result.action === "kicked") {
        console.log(
          `[invite] Kicked ${who}: the invite was for ${result.expectedUserId ?? "another user"}.`,
        );
      } else if (result.action === "allowed") {
        console.log(`[invite] ${who} used their personal invite.`);
      }
    } catch (error) {
      console.error("Invite guard failed:", error.message);
    }
  });
} else {
  console.warn(
    "ENABLE_MEMBER_INTENTS is off, so one-person preview invites can't be enforced. " +
      "Enable the Server Members intent in the Developer Portal and turn it back on.",
  );
}

// Commands are registered in the main server and the preview, and nowhere else.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guildId || !commandGuildIds.has(interaction.guildId)) {
    await interaction
      .reply({
        content: "My commands only work in the main server and its preview server.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  // The database and levelling belong to the main server, so a command run from
  // the preview reads and writes the main server's data, not a second empty copy.
  const dataGuild =
    interaction.guildId === config.sourceId
      ? interaction.guild
      : (previewGuild ?? interaction.guild);

  const handledByLevels = await runLevelCommand(interaction, {
    levels,
    cases,
    guild: dataGuild,
    logCase: (record) => postCase(dataGuild, config.modLogChannelId, record),
    syncRewards: syncLevelRoles,
  });
  if (handledByLevels) return;

  const handledByCounting = await runCountingCommand(interaction, { counting, guild: dataGuild });
  if (handledByCounting) return;

  const handledByUsers = await runUserCommand(interaction, {
    users,
    forum: userForum,
    guild: dataGuild,
  });
  if (handledByUsers) return;

  const handledByDave = await runDaveCommand(interaction, { keys: daveKeys });
  if (handledByDave) return;

  await runModerationCommand(interaction, {
    cases,
    // Cases ran in the preview are logged in the preview's own #mod-logs.
    logChannelId: interaction.guildId === config.sourceId ? config.modLogChannelId : null,
    previewGuild,
    invites: inviteGuard,
    joinBlocks,
  });
});

/** Hand out every role reward the member has now reached (never removes any). */
async function syncLevelRoles(guild, userId, level) {
  const roleIds = levels.rolesFor(guild.id, level);
  if (roleIds.length === 0 || !guild) return;

  let member = guild.members?.cache?.get?.(userId) ?? null;
  if (!member && typeof guild.members?.fetch === "function") {
    member = await guild.members.fetch(userId).catch(() => null);
  }
  if (typeof member?.roles?.add !== "function") return;

  for (const roleId of roleIds) {
    await member.roles.add(roleId, `Level ${level} reward`).catch((error) => {
      console.error(`Could not give the level ${level} role (${roleId}):`, error.message);
    });
  }
}

async function celebrateLevelUp(message, result) {
  const guild = message.guild;
  const settings = levels.settings(guild.id);
  const roleIds = levels.rolesFor(guild.id, result.level);

  if (roleIds.length > 0) await syncLevelRoles(guild, result.userId, result.level);

  const channel = settings.announceChannelId
    ? await guild.channels.fetch(settings.announceChannelId).catch(() => null)
    : message.channel;
  if (typeof channel?.send !== "function") return;

  const lines = [`🎉 <@${result.userId}> reached **level ${result.level}**!`];
  if (roleIds.length > 0) {
    lines.push(`Unlocked ${roleIds.map((id) => `<@&${id}>`).join(", ")}.`);
  }

  await channel
    .send({ content: lines.join("\n"), allowedMentions: { users: [result.userId] } })
    .catch((error) => console.error("Could not post a level-up message:", error.message));
}

// Counting: ✅ on the next number, ❌ and a reset notice on a broken chain.
async function handleCounting(message) {
  let result;
  try {
    result = counting.handleMessage(message);
  } catch (error) {
    console.error("Counting failed:", error.message);
    return;
  }
  if (result.action === "ignored") return;

  if (result.action === "counted") {
    await message.react("✅").catch(() => {});
    return;
  }

  await message.react("❌").catch(() => {});
  if (typeof message.channel?.send !== "function") return;

  const best = result.record > 0 ? ` Best so far: **${result.record}**.` : "";
  const text =
    result.reason === "same-user"
      ? `❌ <@${result.ruinedBy}> can't count twice in a row — **${result.got}** was right, ` +
        `but the chain starts again at **1**.${best}`
      : `❌ <@${result.ruinedBy}> posted **${result.got}** when the next number was ` +
        `**${result.expected}**, so the chain starts again at **1**.${best}`;

  await message.channel
    .send({ content: text, allowedMentions: { users: [result.ruinedBy] } })
    .catch((error) => console.error("Could not post the counting reset:", error.message));
}

// XP is counted in the main server only; the preview stays read-only.
let levelsReady = false;

client.on(Events.MessageCreate, async (message) => {
  if (!levelsReady) return;

  try {
    const result = levels.handleMessage(message);
    if (result?.leveledUp) await celebrateLevelUp(message, result);
  } catch (error) {
    console.error("Level system failed:", error.message);
  }

  await handleCounting(message);
});

// Nothing is mirrored until the startup sync has run, so half-built servers
// can't be edited by events that arrive while it is still working.
let liveReady = false;
let joinServer = null;

// Dave is started by a message beginning with the word "Dave". Members of the
// two servers can ask straight away; everyone else needs a one-time key.
client.on(Events.MessageCreate, async (message) => {
  if (!liveReady) return;
  try {
    await dave.handleMessage(message);
  } catch (error) {
    console.error("Dave failed:", error.message);
  }
});

function on(event, label, run) {
  client.on(event, (...args) => {
    if (!liveReady) return;
    Promise.resolve(run(...args)).catch((error) => {
      console.error(`Could not apply ${label}:`, error.message);
    });
  });
}

on(Events.ChannelCreate, "a created channel", (channel) => live.onChannelCreate(channel));
on(Events.ChannelUpdate, "a channel update", (oldChannel, newChannel) =>
  live.onChannelUpdate(oldChannel, newChannel),
);
on(Events.ChannelDelete, "a deleted channel", (channel) => live.onChannelDelete(channel));

on(Events.RoleCreate, "a created role", (role) => live.onRoleCreate(role));
on(Events.RoleUpdate, "a role update", (oldRole, newRole) =>
  live.onRoleUpdate(oldRole, newRole),
);
on(Events.RoleDelete, "a deleted role", (role) => live.onRoleDelete(role));

on(Events.EmojiCreate, "a created emoji", (emoji) => live.onEmojiCreate(emoji));
on(Events.EmojiUpdate, "an emoji update", (oldEmoji, newEmoji) =>
  live.onEmojiUpdate(oldEmoji, newEmoji),
);
on(Events.EmojiDelete, "a deleted emoji", (emoji) => live.onEmojiDelete(emoji));

on(Events.GuildUpdate, "a server update", (oldGuild, newGuild) =>
  live.onGuildUpdate(oldGuild, newGuild),
);

on(Events.MessageCreate, "a new message", (message) => live.onMessageCreate(message));
on(Events.MessageUpdate, "a message update", (oldMessage, newMessage) =>
  live.onMessageUpdate(oldMessage, newMessage),
);
on(Events.MessageDelete, "a deleted message", (message) => live.onMessageDelete(message));

async function resolveGuild(id) {
  return client.guilds.cache.get(id) ?? (await client.guilds.fetch(id).catch(() => null));
}

/** The "join the real server" button only works when OAuth2 is configured. */
async function setUpJoinFlow(source, target, readyClient) {
  if (!config.clientSecret) {
    console.warn(
      "CLIENT_SECRET is not set, so #join-server was not created. Add it (with the callback(s) " +
        `${config.redirectUris.join(" and ")} in the Developer Portal) to let people join the real server.`,
    );
    return;
  }

  const applicationId = await resolveApplicationId(config.token);
  const flow = createJoinFlow({
    applicationId,
    clientSecret: config.clientSecret,
    token: config.token,
    sourceId: source.id,
    redirectUris: config.redirectUris,
    checkJoin: async (user) => {
      const block = joinBlocks.get(source.id, user.id);
      if (block) {
        throw new UserError(
          `You're blocked from joining ${source.name} from the preview. Reason: ${block.reason}`,
        );
      }
    },
    onJoined: async (user) => {
      await target.members.kick(user.id, "Joined the real server");
      console.log(`Moved ${user.username} from the preview into ${source.name}.`);
    },
  });

  await ensureJoinChannel({
    guild: target,
    client: readyClient,
    sourceName: source.name,
    links: flow.authorizeUrls,
  });

  joinServer = startJoinServer({ flow, port: config.port, path: config.joinPath });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);

  const source = await resolveGuild(config.sourceId);
  const target = await resolveGuild(config.targetId);
  if (!source || !target) {
    const missing = [
      !source ? `source (${config.sourceId})` : null,
      !target ? `target (${config.targetId})` : null,
    ].filter(Boolean);
    console.error(`I'm not in the ${missing.join(" and ")} server. Invite me there first.`);
    process.exit(1);
  }

  const plan = planReplication(snapshotGuild(source), snapshotGuild(target));
  // The preview is named after the source, not an exact copy of the name.
  plan.settings = plan.settings.filter((setting) => setting.key !== "name");

  const report = await applyPlan({
    plan,
    sourceGuild: source,
    targetGuild: target,
    options: { reason: "Server mirroring", readOnly: true },
  });

  console.log(
    `Startup sync: ${report.rolesCreated} role(s) and ${report.channelsCreated} channel(s) created, ` +
      `${report.emojisCreated} emoji(s), ${report.settingsApplied} setting(s) applied.`,
  );
  for (const error of report.errors) console.error(`  ! ${error}`);

  const wantedName = previewName(source.name);
  if (target.name !== wantedName && typeof target.setName === "function") {
    await target.setName(wantedName, "Preview server name").catch((error) => {
      console.error("Could not rename the preview server:", error.message);
    });
  }

  previewGuild = target;
  await inviteGuard.prime(target);

  const commands = [
    ...MOD_COMMANDS,
    ...LEVEL_COMMANDS,
    ...COUNTING_COMMANDS,
    ...USER_COMMANDS,
    ...DAVE_COMMANDS,
  ];
  const payload = commands.map((command) => command.toJSON());
  for (const guild of [source, target]) {
    try {
      await guild.commands.set(payload);
      console.log(`Registered ${commands.length} command(s) in ${guild.name}.`);
    } catch (error) {
      console.error(`Could not register the commands in ${guild.name}:`, error.message);
    }
  }

  await live.attach(source, target);
  liveReady = true;
  levelsReady = true;

  const posted = await syncExistingUserPosts({ forum: userForum, users, guild: source });
  if (posted > 0) console.log(`Posted ${posted} stored user record(s) in the user forum.`);

  if (!config.enableMessageContent) {
    console.warn(
      "ENABLE_MESSAGE_CONTENT is off, so messages are not mirrored — only the server structure. " +
        "Turn the intent on in the Developer Portal, set ENABLE_MESSAGE_CONTENT=true in the " +
        "environment the bot actually runs in (the Portal toggle alone is not enough), and restart. " +
        `This process read ${JSON.stringify(config.messageContentEnv)} — null means the variable ` +
        "never reached it.",
    );
  }

  try {
    await setUpJoinFlow(source, target, readyClient);
  } catch (error) {
    console.error("Join flow disabled:", error.message);
  }

  console.log(`Mirroring ${source.name} (${source.id}) -> ${target.name} (${target.id}) live.`);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("SIGINT", () => {
  joinServer?.close();
  client.destroy();
  process.exit(0);
});

client.login(config.token).catch((error) => {
  console.error("Login failed:", error.message);
  if (/disallowed intent/i.test(error.message)) {
    console.error(
      "Enable **Server Members** (and Message Content, since mirroring messages is on by " +
        "default) under Developer Portal → Bot → Privileged Gateway Intents, or set " +
        "ENABLE_MEMBER_INTENTS=false / ENABLE_MESSAGE_CONTENT=false.",
    );
  }
  process.exit(1);
});
