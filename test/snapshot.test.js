import test from "node:test";
import assert from "node:assert/strict";
import { fakeSourceGuild } from "./fixtures.js";
import { snapshotGuild } from "../src/lib/snapshot.js";

test("snapshotGuild excludes @everyone and orders roles by hierarchy", () => {
  const snapshot = snapshotGuild(fakeSourceGuild());

  assert.deepEqual(
    snapshot.roles.map((role) => role.name),
    ["Moderator", "SomeBot"],
  );
  assert.equal(snapshot.roles[0].permissions, "8");
  assert.equal(snapshot.roles[1].managed, true);
});

test("snapshotGuild keeps cloneable channels and maps their types", () => {
  const snapshot = snapshotGuild(fakeSourceGuild());

  const names = snapshot.channels.map((channel) => `${channel.type}:${channel.name}`);
  assert.deepEqual(names, ["category:Rules", "text:welcome", "voice:Lounge"]);
  assert.equal(snapshot.channels.some((channel) => channel.name === "Directory"), false);
});

test("snapshotGuild copies channel settings and permission overwrites", () => {
  const snapshot = snapshotGuild(fakeSourceGuild());
  const text = snapshot.channels.find((channel) => channel.name === "welcome");

  assert.equal(text.parentId, "2001");
  assert.equal(text.topic, "Be nice");
  assert.equal(text.rateLimitPerUser, 5);
  assert.deepEqual(text.overwrites, [
    { type: "role", id: "1001", allow: "1024", deny: "0" },
  ]);

  const voice = snapshot.channels.find((channel) => channel.name === "Lounge");
  assert.equal(voice.bitrate, 64000);
  assert.equal(voice.userLimit, 5);
});

test("snapshotGuild reads emojis and server settings", () => {
  const snapshot = snapshotGuild(fakeSourceGuild());

  assert.deepEqual(snapshot.emojis.map((emoji) => emoji.name), ["party"]);
  assert.equal(snapshot.settings.afkTimeout, 300);
  assert.equal(snapshot.settings.verificationLevel, 1);
});
