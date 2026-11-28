import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { createJoinFlow, ensureJoinChannel } from "../src/lib/join.js";

const DOMAINS = [
  "https://45tapl8dqb.apps.bot-hosting.cloud",
  "https://limey-discord.apps.bot-hosting.cloud",
];
const redirectUris = DOMAINS.map((domain) => `${domain}/join/callback`);

function createFlow(overrides = {}) {
  return createJoinFlow({
    applicationId: "app-1",
    clientSecret: "secret",
    token: "token",
    sourceId: "1000",
    redirectUris,
    onJoined: async () => {},
    ...overrides,
  });
}

test("every domain gets its own link, state and redirect uri", () => {
  const { authorizeUrls } = createFlow();

  assert.equal(authorizeUrls.length, 2);
  const states = authorizeUrls.map((link) => new URL(link.url).searchParams.get("state"));
  assert.equal(new Set(states).size, 2, "states are unique per domain");

  for (const link of authorizeUrls) {
    const url = new URL(link.url);
    assert.equal(url.origin, "https://discord.com");
    assert.equal(url.searchParams.get("redirect_uri"), link.redirectUri);
    assert.equal(url.searchParams.get("client_id"), "app-1");
    assert.equal(url.searchParams.get("scope"), "identify guilds.join");
    assert.equal(link.host, new URL(link.redirectUri).host);
  }
});

test("the same domain listed twice is only linked once", () => {
  const { authorizeUrls } = createFlow({ redirectUris: [redirectUris[0], redirectUris[0]] });

  assert.equal(authorizeUrls.length, 1);
});

test("a callback whose state belongs to no domain is refused before any request", async () => {
  const flow = createFlow();

  await assert.rejects(flow.complete({ code: "abc", state: "not-a-real-state" }), /state/);
});

test("a missing redirect uri is a configuration error", () => {
  assert.throws(() => createFlow({ redirectUris: [] }), /redirect URI/);
});

function fakeTarget() {
  const edits = [];
  const sent = [];

  const channel = {
    id: "join-channel",
    name: "join-server",
    type: ChannelType.GuildText,
    permissionOverwrites: {
      async edit(id, permissions) {
        edits.push({ id, permissions });
      },
    },
    messages: { async fetch() { return []; } },
    async send(payload) {
      sent.push(payload);
    },
  };

  const guild = {
    id: "guild-1",
    roles: { everyone: { id: "guild-1" } },
    channels: {
      cache: new Map([[channel.id, channel]]),
      async create() {
        return channel;
      },
    },
  };

  return { guild, channel, edits, sent };
}

test("the join channel gets one button per domain and stays read-only", async () => {
  const flow = createFlow();
  const { guild, edits, sent } = fakeTarget();

  await ensureJoinChannel({
    guild,
    client: { user: { id: "bot-1" } },
    sourceName: "Main",
    links: flow.authorizeUrls,
  });

  assert.equal(sent.length, 1);
  const buttons = sent[0].components[0].components;
  assert.equal(buttons.length, 2);
  assert.deepEqual(
    buttons.map((button) => button.data.url),
    flow.authorizeUrls.map((link) => link.url),
  );
  assert.ok(buttons.every((button) => button.data.style === 5), "link buttons");

  assert.deepEqual(edits[0].id, { id: "guild-1" }, "the @everyone role is edited");
  assert.equal(edits[0].permissions.SendMessages, false);
  assert.equal(edits[0].permissions.ViewChannel, true);
  assert.equal(sent[0].embeds[0].data.title, "🚪 Join Main");
});
