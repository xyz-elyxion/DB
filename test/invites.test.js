import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVITE_MAX_AGE_SECONDS,
  createInviteGuard,
  parseInviteCode,
  pickInviteChannel,
} from "../src/lib/invites.js";

function fakePreview({ channels = null } = {}) {
  const store = new Map();
  let sequence = 0;

  const textChannels =
    channels ??
    [
      { id: "c-general", name: "general", type: ChannelType.GuildText },
      { id: "c-join", name: "join-server", type: ChannelType.GuildText },
    ];

  const guild = {
    id: "preview",
    name: "Main Preview",
    channels: { cache: new Map(textChannels.map((channel) => [channel.id, channel])) },
    invites: {
      async fetch() {
        return new Map(store);
      },
      async create(channel, options) {
        const code = `code-${++sequence}`;
        const invite = {
          code,
          uses: 0,
          channelId: channel.id,
          options,
          url: `https://discord.gg/${code}`,
          async delete() {
            store.delete(code);
            invite.deleted = true;
          },
        };
        store.set(code, invite);
        return invite;
      },
    },
  };

  return { guild, store, textChannels };
}

function joiner(guild, id) {
  return {
    id,
    guild,
    user: { id, tag: `${id}#0001` },
    kicked: false,
    async kick() {
      this.kicked = true;
    },
  };
}

test("invite codes are read from bare codes and links", () => {
  assert.equal(parseInviteCode("abc123"), "abc123");
  assert.equal(parseInviteCode("https://discord.gg/abc123"), "abc123");
  assert.equal(parseInviteCode("https://discord.com/invite/AbC-123"), "AbC-123");
  assert.equal(parseInviteCode(" https://discordapp.com/invite/xyz "), "xyz");
  assert.equal(parseInviteCode("  "), "");
});

test("the invite lands in #join-server when it exists", () => {
  const { guild } = fakePreview();
  assert.equal(pickInviteChannel(guild).id, "c-join");
});

test("a personal invite is single use, lasts a week and is remembered", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });

  const { invite, record } = await guard.createLocked({ guild, userId: "u1", inviterId: "mod" });

  assert.equal(invite.options.maxUses, 1);
  assert.equal(invite.options.maxAge, INVITE_MAX_AGE_SECONDS);
  assert.equal(invite.options.unique, true);
  assert.equal(invite.channelId, "c-join");
  assert.equal(record.userId, "u1");
  assert.equal(record.url, `https://discord.gg/${record.code}`);
  assert.ok(store.has(record.code));
  assert.equal(guard.pending, 1);
});

test("the invited person gets in and the link is retired", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });
  const { record } = await guard.createLocked({ guild, userId: "u1" });

  store.delete(record.code); // Discord removes a single-use invite once it is used

  const member = joiner(guild, "u1");
  const result = await guard.handleJoin(member);

  assert.equal(result.action, "allowed");
  assert.equal(member.kicked, false);
  assert.equal(guard.pending, 0);
});

test("anyone else is kicked and the invite is gone", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });
  const { record } = await guard.createLocked({ guild, userId: "u1" });

  store.delete(record.code);

  const member = joiner(guild, "u2");
  const result = await guard.handleJoin(member);

  assert.equal(result.action, "kicked");
  assert.equal(result.expectedUserId, "u1");
  assert.equal(member.kicked, true);
  assert.equal(guard.pending, 0, "the invite is no longer tracked");
});

test("removing a personal invite deletes it and stops the kick guard tracking it", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });
  const { record } = await guard.createLocked({ guild, userId: "u1" });

  const result = await guard.remove({ guild, code: record.code });

  assert.equal(result.userId, "u1");
  assert.equal(store.has(record.code), false, "the invite is gone from Discord");
  assert.equal(guard.pending, 0);

  const member = joiner(guild, "u1");
  assert.equal((await guard.handleJoin(member)).action, "ignored");
  assert.equal(member.kicked, false);
});

test("removing an invite that is already gone just forgets it", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });
  const { record } = await guard.createLocked({ guild, userId: "u1" });
  store.delete(record.code);

  const result = await guard.remove({ guild, code: record.code });

  assert.equal(result.userId, "u1");
  assert.equal(guard.pending, 0);
});

test("an unknown invite can't be removed", async () => {
  const { guild } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });

  await assert.rejects(guard.remove({ guild, code: "nope" }), /no invite/);
});

test("joins through ordinary invites are left alone", async () => {
  const { guild, store } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });
  await guard.createLocked({ guild, userId: "u1" });

  const ordinary = await guild.invites.create({ id: "c-general" }, { maxUses: 0 });
  ordinary.uses = 1;

  const member = joiner(guild, "u3");
  const result = await guard.handleJoin(member);

  assert.equal(result.action, "ignored");
  assert.equal(member.kicked, false);
  assert.equal(store.size, 2);
});

test("locked invites survive a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "invites-"));
  const file = join(directory, "invites.json");

  try {
    const { guild, store } = fakePreview();
    const first = createInviteGuard({ guildId: "preview", file });
    const { record } = await first.createLocked({ guild, userId: "u1" });

    const second = createInviteGuard({ guildId: "preview", file });
    assert.equal(second.pending, 1);

    store.delete(record.code);
    const member = joiner(guild, "intruder");
    assert.equal((await second.handleJoin(member)).action, "kicked");
    assert.equal(member.kicked, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("joins in another server are ignored", async () => {
  const { guild } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });

  const result = await guard.handleJoin({ ...joiner(guild, "u1"), guild: { ...guild, id: "elsewhere" } });
  assert.equal(result.action, "ignored");
});

test("creating an invite in a server the guard doesn't own fails loudly", async () => {
  const { guild } = fakePreview();
  const guard = createInviteGuard({ guildId: "preview" });

  await assert.rejects(guard.createLocked({ guild: { ...guild, id: "main" }, userId: "u1" }), /preview/);
});
