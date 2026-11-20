import { Client, Events, GatewayIntentBits } from "discord.js";
import { assertConfig, config } from "./config.js";
import { applyPlan } from "./lib/builder.js";
import { createLiveSync } from "./lib/live.js";
import { planReplication } from "./lib/planner.js";
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

const client = new Client({ intents });
const live = createLiveSync({
  sourceId: config.sourceId,
  targetId: config.targetId,
  client,
  reason: "Server mirroring",
});

// Nothing is mirrored until the startup sync has run, so half-built servers
// can't be edited by events that arrive while it is still working.
let liveReady = false;

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
  const report = await applyPlan({
    plan,
    sourceGuild: source,
    targetGuild: target,
    options: { reason: "Server mirroring" },
  });

  console.log(
    `Startup sync: ${report.rolesCreated} role(s) and ${report.channelsCreated} channel(s) created, ` +
      `${report.emojisCreated} emoji(s), ${report.settingsApplied} setting(s) applied.`,
  );
  for (const error of report.errors) console.error(`  ! ${error}`);

  await live.attach(source, target);
  liveReady = true;

  if (!config.enableMessageContent) {
    console.warn(
      "ENABLE_MESSAGE_CONTENT is off, so messages are not mirrored — only the server structure. " +
        "Enable the intent in the Developer Portal, set ENABLE_MESSAGE_CONTENT=true, and restart.",
    );
  }

  console.log(`Mirroring ${source.name} (${source.id}) -> ${target.name} (${target.id}) live.`);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("SIGINT", () => {
  client.destroy();
  process.exit(0);
});

client.login(config.token).catch((error) => {
  console.error("Login failed:", error.message);
  process.exit(1);
});
