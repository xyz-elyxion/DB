import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, EmbedBuilder } from "discord.js";
import { isStyledEmbed, restyleEmbed, restyleEmbeds } from "../src/lib/embeds.js";
import { migrateEmbeds } from "../src/lib/embedmigrate.js";
import { EMBED_COMMANDS, runEmbedCommand } from "../src/lib/embedcommands.js";

/** The embeds the bot posted before the style tag existed. */
function oldUserRecord() {
  return new EmbedBuilder()
    .setColor(0xeb459e)
    .setAuthor({ name: "ada.l" })
    .setTitle("User record")
    .addFields(
      { name: "First name", value: "Ada", inline: true },
      { name: "Last name", value: "Lovelace", inline: true },
      { name: "Username", value: "ada.l", inline: true },
      { name: "Email", value: "ada@example.com", inline: true },
      { name: "Date of birth", value: "1990-12-10 (age 35)", inline: true },
      { name: "Class", value: "10A", inline: true },
      { name: "Gender", value: "Female", inline: true },
      { name: "Discord", value: "<@123456789012345678>", inline: true },
      { name: "Roles", value: "`Student`, `Prefect`" },
    )
    .setFooter({ text: "Last updated 2026-01-02" });
}

function oldRank() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: "ada" })
    .setTitle("Level 3")
    .addFields(
      { name: "Rank", value: "#2 of 12", inline: true },
      { name: "Total XP", value: "1,000", inline: true },
      { name: "Messages", value: "80", inline: true },
      { name: "Progress to level 4", value: "██░░  100 / 400 XP" },
    )
    .setFooter({ text: "25% of the way to the next level" });
}

function oldLeaderboard() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Leaderboard — page 1/2")
    .setDescription("🥇 <@u2> — level 5, 2,000 XP")
    .setFooter({ text: "12 member(s) ranked" });
}

function oldCounting() {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("Counting")
    .addFields({ name: "Channel", value: "<#c1>", inline: true })
    .setFooter({ text: "One number per message" });
}

function oldCase() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("Case #7 — ban")
    .addFields({ name: "Reason", value: "Spam" })
    .setFooter({ text: "Case #7" })
    .setTimestamp(new Date("2026-02-03T04:05:06Z"));
}

function oldJoin() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Join Main")
    .setDescription("This server is a read-only preview of **Main**.")
    .setFooter({ text: "You only need to do this once" });
}

test("the old user record becomes the new card, keeping its data", () => {
  const { embed, kind } = restyleEmbed(oldUserRecord());
  assert.equal(kind, "user-record");

  const data = embed.toJSON();
  const fields = Object.fromEntries(data.fields.map((field) => [field.name, field.value]));

  assert.equal(data.title, "👤 Ada Lovelace");
  assert.match(data.description, /ada\.l/);
  assert.equal(fields.Email, "ada@example.com");
  assert.equal(fields.Discord, "<@123456789012345678>");
  assert.equal(fields.Roles, "`Student`, `Prefect`");
  assert.match(fields["Date of birth"], /1990-12-10/);
  assert.match(data.footer.text, /Mirror Bot v2/);
  assert.ok(isStyledEmbed(data));
});

test("old rank, leaderboard, counting, case and join embeds convert", () => {
  const rank = restyleEmbed(oldRank());
  assert.equal(rank.kind, "rank");
  const rankData = rank.embed.toJSON();
  assert.equal(rankData.title, "📈 Level 3");
  assert.match(rankData.description, /100 \/ 400 XP/);
  assert.equal(rankData.fields.find((field) => field.name === "Rank").value, "#2 of 12");
  assert.equal(rankData.footer.text, "25% of the way to the next level • Mirror Bot v2");

  const leaderboard = restyleEmbed(oldLeaderboard()).embed.toJSON();
  assert.equal(leaderboard.title, "🏆 Leaderboard — page 1/2");
  assert.match(leaderboard.description, /<@u2>/);

  const counting = restyleEmbed(oldCounting()).embed.toJSON();
  assert.equal(counting.title, "🔢 Counting");
  assert.equal(counting.fields[0].value, "<#c1>");

  const moderator = restyleEmbed(oldCase());
  assert.equal(moderator.kind, "case");
  assert.equal(moderator.embed.toJSON().title, "🛡️ Case #7 — ban");
  assert.equal(moderator.embed.toJSON().color, 0xed4245, "the case colour is kept");

  const join = restyleEmbed(oldJoin()).embed.toJSON();
  assert.equal(join.title, "🚪 Join Main");
});

test("deleted records convert and an unknown embed is left alone", () => {
  const deleted = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Record deleted")
    .setDescription("**Ada Lovelace** (`ada.l`) is no longer in the database.")
    .setFooter({ text: "Deleted 2026-01-05" });

  assert.equal(restyleEmbed(deleted).embed.toJSON().title, "🗑️ Record deleted");

  const foreign = new EmbedBuilder()
    .setTitle("Server rules")
    .setDescription("Be nice.")
    .setFooter({ text: "Another bot" });
  assert.deepEqual(restyleEmbed(foreign), { embed: null, kind: null });
});

test("an embed already in the new style is reported as current, not rebuilt", () => {
  const current = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🔢 Counting")
    .setFooter({ text: "Mirror Bot v2" });

  const result = restyleEmbed(current);
  assert.equal(result.kind, "current");
  assert.equal(result.embed, null);
  assert.ok(isStyledEmbed(current));
});

test("a message's embeds are rewritten together, keeping unknown ones", () => {
  const foreign = new EmbedBuilder().setTitle("Someone else's embed");
  const result = restyleEmbeds([oldCounting(), foreign]);

  assert.equal(result.converted, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(result.kinds, ["counting"]);
  assert.equal(result.embeds.length, 2);
  assert.equal(result.embeds[1], foreign, "the unknown embed is untouched");
});

function message({ id, content, embeds, bot = true }) {
  return {
    id,
    content,
    embeds,
    author: { id: bot ? "bot" : "human", bot },
    edits: [],
    async edit(payload) {
      this.edits.push(payload);
      this.embeds = payload.embeds;
    },
  };
}

function textChannel({ id = "c1", name = "general", messages = [] } = {}) {
  return {
    id,
    name,
    type: ChannelType.GuildText,
    messages: {
      async fetch() {
        return new Map(messages.map((entry) => [entry.id, entry]));
      },
    },
  };
}

function forumChannel({ id = "f1", name = "user-records", threads = [] } = {}) {
  return {
    id,
    name,
    type: ChannelType.GuildForum,
    threads: {
      async fetchActive() {
        return { threads: new Map(threads.filter((t) => !t.archived).map((t) => [t.id, t])) };
      },
      async fetchArchived() {
        const archived = threads.filter((t) => t.archived);
        return { threads: new Map(archived.map((t) => [t.id, t])), hasMore: false };
      },
    },
  };
}

function thread({ id = "t1", name = "Ada Lovelace (ada.l)", archived = false, messages = [] } = {}) {
  return {
    id,
    name,
    archived,
    unarchived: 0,
    messages: {
      async fetch() {
        return new Map(messages.map((entry) => [entry.id, entry]));
      },
    },
    async setArchived(value) {
      this.archived = value;
      this.unarchived += 1;
    },
  };
}

test("migration rewrites the bot's old embeds in both channels and forum posts", async () => {
  const stale = message({ id: "m1", content: "", embeds: [oldRank()] });
  const fresh = new EmbedBuilder().setTitle("🔢 Counting").setFooter({ text: "Mirror Bot v2" });
  const current = message({ id: "m2", content: "", embeds: [fresh] });
  const human = message({ id: "m3", content: "hi", embeds: [oldRank()], bot: false });
  const postEmbed = message({ id: "m4", content: "", embeds: [oldUserRecord()] });

  const channel = textChannel({ messages: [stale, current, human] });
  const forum = forumChannel({ threads: [thread({ messages: [postEmbed] })] });

  const guild = {
    id: "g1",
    name: "Main",
    channels: { cache: new Map([[channel.id, channel], [forum.id, forum]]) },
  };

  const report = await migrateEmbeds({ guilds: [guild], botId: "bot", delayMs: 0 });

  assert.equal(report.messagesScanned, 3, "only the bot's own embeds count");
  assert.equal(report.converted, 2);
  assert.equal(report.updated, 2);
  assert.equal(report.threadsScanned, 1);
  assert.deepEqual(report.kinds, { rank: 1, "user-record": 1 });

  assert.equal(stale.edits.length, 1);
  assert.equal(stale.embeds[0].toJSON().title, "📈 Level 3");
  assert.equal(postEmbed.embeds[0].toJSON().title, "👤 Ada Lovelace");
  assert.equal(current.edits.length, 0, "already new style");
  assert.equal(human.edits.length, 0, "not the bot's message");
});

test("a dry run counts the work without editing anything", async () => {
  const stale = message({ id: "m1", content: "", embeds: [oldCounting()] });
  const channel = textChannel({ messages: [stale] });
  const guild = { id: "g1", name: "Main", channels: { cache: new Map([[channel.id, channel]]) } };

  const report = await migrateEmbeds({ guilds: [guild], botId: "bot", dryRun: true });

  assert.equal(report.converted, 1);
  assert.equal(report.updated, 0);
  assert.equal(stale.edits.length, 0);
});

test("archived forum posts are re-archived after being read", async () => {
  const post = message({ id: "m1", content: "", embeds: [oldUserRecord()] });
  const archived = thread({ archived: true, messages: [post] });
  const forum = forumChannel({ threads: [archived] });
  const guild = { id: "g1", name: "Main", channels: { cache: new Map([[forum.id, forum]]) } };

  await migrateEmbeds({ guilds: [guild], botId: "bot", delayMs: 0 });

  assert.equal(archived.archived, true);
  assert.equal(archived.unarchived, 1);
  assert.equal(post.edits.length, 1);
});

test("/migrate-embeds is Manage Server only and reports what it did", async () => {
  assert.deepEqual(
    EMBED_COMMANDS.map((command) => command.name),
    ["migrate-embeds"],
  );
  assert.ok(EMBED_COMMANDS[0].toJSON().options.some((option) => option.name === "dry-run"));

  const replies = [];
  const edits = [];
  const stale = message({ id: "m1", content: "", embeds: [oldLeaderboard()] });
  const channel = textChannel({ messages: [stale] });
  const guild = { id: "g1", name: "Main", channels: { cache: new Map([[channel.id, channel]]) } };

  function interactionFor({ can = true } = {}) {
    return {
      commandName: "migrate-embeds",
      guild,
      member: { id: "mod", permissions: { has: () => can } },
      client: { user: { id: "bot" } },
      options: {
        getBoolean: () => false,
        getInteger: () => 50,
      },
      async deferReply() {},
      async editReply(payload) {
        replies.push(payload);
      },
      async reply(payload) {
        edits.push(payload);
      },
    };
  }

  const denied = interactionFor({ can: false });
  await runEmbedCommand(denied, { guilds: [guild], botId: "bot" });
  assert.match(replies[0].content, /Manage Server/);
  assert.equal(stale.edits.length, 0);

  const allowed = interactionFor();
  await runEmbedCommand(allowed, { guilds: [guild], botId: "bot" });
  assert.equal(stale.edits.length, 1);
  assert.match(replies.at(-1).content, /Rewrote \*\*1\*\* embed/);
  assert.match(replies.at(-1).content, /1 leaderboard/);
});
