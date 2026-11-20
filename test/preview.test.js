import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { previewName, readOnlyOverwrites } from "../src/lib/preview.js";

test("the target is named after the source with Preview added", () => {
  assert.equal(previewName("My Server"), "My Server Preview");
  assert.equal(previewName("   "), "Server Preview");
  assert.equal(previewName(undefined), "Server Preview");
});

test("Preview is only added once", () => {
  assert.equal(previewName("My Server Preview"), "My Server Preview");
  assert.equal(previewName("my server preview"), "my server preview");
});

test("an existing @everyone overwrite is extended, not duplicated", () => {
  const overwrites = readOnlyOverwrites(
    [{ id: "everyone", allow: 2048n, deny: 0n }],
    "everyone",
  );

  assert.equal(overwrites.length, 1);
  assert.equal(overwrites[0].allow & 2048n, 2048n, "existing allow is kept");
  assert.equal(
    overwrites[0].allow & PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ViewChannel,
  );
  assert.ok(overwrites[0].deny & PermissionFlagsBits.SendMessages);
  assert.ok(overwrites[0].deny & PermissionFlagsBits.Speak);
});

test("an @everyone overwrite is added when there isn't one", () => {
  const overwrites = readOnlyOverwrites(
    [{ id: "role-1", allow: 1024n, deny: 0n }],
    "everyone",
  );

  assert.equal(overwrites.length, 2);
  assert.deepEqual(overwrites[1].id, "everyone");
  assert.ok(overwrites[1].deny & PermissionFlagsBits.CreatePublicThreads);
  assert.ok(overwrites[1].deny & PermissionFlagsBits.AddReactions);
});
