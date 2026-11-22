import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { assertConfig, config } from "./config.js";
import { applyPlan } from "./lib/builder.js";
import { createCaseStore } from "./lib/cases.js";
import { UserError } from "./lib/errors.js";
import { createInviteGuard } from "./lib/invites.js";
import { createJoinBlockStore } from "./lib/joinblocks.js";
import {
  createJoinFlow,
  ensureJoinChannel,
  resolveApplicationId,
  startJoinServer,
} from "./lib/join.js";
import { createLiveSync } from "./lib/live.js";
import { MOD_COMMANDS, runModerationCommand } from "./lib/moderation.js";
import { planReplication } from "./lib/planner.js";
import { previewName } from "./lib/preview.js";
import { snapshotGuild } from "./lib/snapshot.js";

try {
  assertConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const intents = [GatewayIntentBits.Guilds];
if (config.enableMessageContent) {
  intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}
if (config.enableMemberEvents) {
  intents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({ intents });
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

// Moderation belongs to the real server; the preview is read-only anyway.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.guildId !== config.sourceId) {
    await interaction
      .reply({
        content: "Moderation commands only work in the main server.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await runModerationCommand(interaction, {
    cases,
    logChannelId: config.modLogChannelId,
    previewGuild,
    invites: inviteGuard,
    joinBlocks,
  });
});

// Nothing is mirrored until the startup sync has run, so half-built servers
// can't be edited by events that arrive while it is still working.
let liveReady = false;
let joinServer = null;

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

  try {
    await source.commands.set(MOD_COMMANDS.map((command) => command.toJSON()));
    console.log(`Registered ${MOD_COMMANDS.length} moderation command(s) in ${source.name}.`);
  } catch (error) {
    console.error("Could not register the moderation commands:", error.message);
  }

  await live.attach(source, target);
  liveReady = true;

  if (!config.enableMessageContent) {
    console.warn(
      "ENABLE_MESSAGE_CONTENT is off, so messages are not mirrored — only the server structure. " +
        "Enable the intent in the Developer Portal, set ENABLE_MESSAGE_CONTENT=true, and restart.",
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
      "Enable **Server Members** (and Message Content, if you mirror messages) under " +
        "Developer Portal → Bot → Privileged Gateway Intents, or set ENABLE_MEMBER_INTENTS=false.",
    );
  }
  process.exit(1);
});
