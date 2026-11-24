import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { findMirrorChannel, mirrorMessage, shouldMirror } from "../src/lib/mirror.js";

function fakeChannel({ id = "t1", name = "general", type = ChannelType.GuildText } = {}) {
  const hook = {
    name: "Server mirror",
    sends: [],
    async send(payload) {
      this.sends.push(payload);
    },
  };

  const channel = {
    id,
    name,
    type,
    parent: null,
    webhookRequests: 0,
    created: [],
    hook,
    async fetchWebhooks() {
      channel.webhookRequests += 1;
      return [];
    },
    async createWebhook(payload) {
      channel.created.push(payload);
      return hook;
    },
  };

  return channel;
}

function fakeGuild(channels) {
  return { channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) } };
}

function fakeMessage({
  channel,
  content = "hello there",
  bot = false,
  attachments = new Map(),
  embeds = [],
}) {
  return {
    guild: { id: "1000" },
    system: false,
    webhookId: null,
    channel,
    content,
    attachments,
    embeds,
    author: {
      id: "u1",
      bot,
      username: "Ada",
      displayAvatarURL: () => "https://cdn.example/ada.png",
    },
    member: { displayName: "Ada" },
  };
}

test("channels are matched by name and type", () => {
  const source = fakeChannel({ name: "general" });
  const voice = fakeChannel({ id: "v1", name: "general", type: ChannelType.GuildVoice });
  const text = fakeChannel({ id: "t2", name: "General" });

  assert.equal(findMirrorChannel(source, fakeGuild([voice, text])), text);
  assert.equal(findMirrorChannel(source, fakeGuild([voice])), null);
});

test("the channel in the matching category wins", () => {
  const source = fakeChannel({ name: "general" });
  source.parent = { name: "Talk" };

  const elsewhere = fakeChannel({ id: "t1", name: "general" });
  elsewhere.parent = { name: "Archive" };
  const inCategory = fakeChannel({ id: "t2", name: "general" });
  inCategory.parent = { name: "Talk" };

  assert.equal(findMirrorChannel(source, fakeGuild([elsewhere, inCategory])), inCategory);
});

test("bots and webhook posts are copied, system notes and empty messages are not", () => {
  const channel = fakeChannel();

  assert.equal(shouldMirror(fakeMessage({ channel })), true);
  assert.equal(shouldMirror(fakeMessage({ channel, bot: true })), true);
  assert.equal(shouldMirror(fakeMessage({ channel, content: "   " })), false);

  const webhookMessage = fakeMessage({ channel });
  webhookMessage.webhookId = "w1";
  assert.equal(shouldMirror(webhookMessage), true);

  const systemMessage = fakeMessage({ channel });
  systemMessage.system = true;
  assert.equal(shouldMirror(systemMessage), false);

  const voiceChannel = fakeChannel({ type: ChannelType.GuildVoice });
  assert.equal(shouldMirror(fakeMessage({ channel: voiceChannel })), false);
});

test("a new message is reposted through a webhook as its author", async () => {
  const target = fakeChannel({ id: "t1", name: "general" });
  const message = fakeMessage({ channel: fakeChannel({ name: "general" }) });

  const result = await mirrorMessage({
    message,
    targetGuild: fakeGuild([target]),
    client: { user: { id: "bot" } },
  });

  assert.equal(result.mirrored, true);
  assert.equal(target.created[0].name, "Server mirror");
  assert.equal(target.hook.sends.length, 1);
  assert.equal(target.hook.sends[0].content, "hello there");
  assert.equal(target.hook.sends[0].username, "Ada");
  assert.equal(target.hook.sends[0].avatarURL, "https://cdn.example/ada.png");
  assert.deepEqual(target.hook.sends[0].allowedMentions, { parse: [] });
});

test("an embed-only bot message is posted with its embeds", async () => {
  const target = fakeChannel();
  const embed = { title: "Build finished", description: "All green" };
  const message = fakeMessage({
    channel: fakeChannel(),
    content: "",
    bot: true,
    embeds: [embed],
  });

  const result = await mirrorMessage({ message, targetGuild: fakeGuild([target]), client: {} });

  assert.equal(result.mirrored, true);
  assert.equal(target.hook.sends.length, 1);
  assert.equal(target.hook.sends[0].content, "");
  assert.deepEqual(target.hook.sends[0].embeds, [embed]);
});

test("bot text and its embeds are copied in one post", async () => {
  const target = fakeChannel();
  const embed = { title: "Now playing" };
  const message = fakeMessage({ channel: fakeChannel(), content: "track 3", bot: true, embeds: [embed] });

  await mirrorMessage({ message, targetGuild: fakeGuild([target]), client: {} });

  assert.equal(target.hook.sends[0].content, "track 3");
  assert.deepEqual(target.hook.sends[0].embeds, [embed]);
});

test("attachments are forwarded as links on the first message", async () => {
  const target = fakeChannel();
  const attachments = new Map([["a1", { id: "a1", url: "https://cdn.example/cat.png" }]]);
  const message = fakeMessage({ channel: fakeChannel(), content: "", attachments });

  await mirrorMessage({ message, targetGuild: fakeGuild([target]), client: {} });

  assert.deepEqual(target.hook.sends[0].files, ["https://cdn.example/cat.png"]);
});

test("long messages are split across several webhook posts", async () => {
  const target = fakeChannel();
  const content = Array.from({ length: 200 }, (_, index) => "word ".repeat(10)).join("\n");
  const message = fakeMessage({ channel: fakeChannel(), content });

  const result = await mirrorMessage({ message, targetGuild: fakeGuild([target]), client: {} });

  assert.ok(target.hook.sends.length > 1);
  assert.equal(result.chunks, target.hook.sends.length);
  for (const send of target.hook.sends) assert.ok(send.content.length <= 2000);
});

test("a cached webhook is reused instead of creating one per message", async () => {
  const target = fakeChannel();
  const hooks = new Map();
  const message = fakeMessage({ channel: fakeChannel() });
  const options = { targetGuild: fakeGuild([target]), client: {}, hooks };

  await mirrorMessage({ message, ...options });
  await mirrorMessage({ message, ...options });

  assert.equal(target.created.length, 1);
  assert.equal(target.webhookRequests, 1);
  assert.equal(target.hook.sends.length, 2);
});

test("a channel missing from the target is reported instead of failing", async () => {
  const message = fakeMessage({ channel: fakeChannel({ name: "secret" }) });
  const result = await mirrorMessage({
    message,
    targetGuild: fakeGuild([fakeChannel({ name: "general" })]),
    client: {},
  });

  assert.equal(result.mirrored, false);
  assert.equal(result.reason, "no matching channel");
});
