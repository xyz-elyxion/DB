import test from "node:test";
import assert from "node:assert/strict";
import { makeChannel, makeRole, makeSnapshot } from "./fixtures.js";
import { planReplication } from "../src/lib/planner.js";

function source() {
  return makeSnapshot({
    roles: [
      makeRole({ id: "r1", name: "Admin", position: 3, permissions: "8" }),
      makeRole({ id: "r2", name: "BotFriend", position: 2, managed: true }),
      makeRole({ id: "r3", name: "Member", position: 1, color: 0x112233 }),
    ],
    channels: [
      makeChannel({ id: "cat1", name: "INFO", type: "category", position: 0 }),
      makeChannel({
        id: "ch1",
        name: "rules",
        parentId: "cat1",
        position: 0,
        overwrites: [
          { type: "role", id: "r2", allow: "1024", deny: "0" },
          { type: "role", id: "1000", allow: "0", deny: "2048" },
        ],
      }),
      makeChannel({ id: "ch2", name: "voice", type: "voice", position: 1 }),
    ],
    emojis: [{ id: "e1", name: "party", animated: false, url: "https://cdn/party.png" }],
  });
}

test("plans creations when the target is empty", () => {
  const plan = planReplication(source(), makeSnapshot({ name: "Preview" }));

  assert.equal(plan.stats.roles.create, 2);
  assert.equal(plan.stats.roles.skip, 1);
  assert.equal(plan.stats.categories.create, 1);
  assert.equal(plan.stats.channels.create, 2);
  assert.equal(plan.stats.emojis.create, 1);
  assert.equal(plan.roles[0].action, "create");
});

test("keeps category order before its children and links parents", () => {
  const plan = planReplication(source(), makeSnapshot());

  const child = plan.channels.find((channel) => channel.name === "rules");
  assert.equal(child.parentSourceId, "cat1");
  assert.equal(plan.categories[0].sourceId, "cat1");
});

test("reuses matching roles and channels instead of duplicating them", () => {
  const target = makeSnapshot({
    roles: [makeRole({ id: "t1", name: "member", position: 1, color: 0 })],
    channels: [
      makeChannel({ id: "tc1", name: "INFO", type: "category" }),
      makeChannel({ id: "tc2", name: "voice", type: "voice" }),
    ],
  });

  const plan = planReplication(source(), target);
  const member = plan.roles.find((role) => role.name === "Member");
  const voice = plan.channels.find((channel) => channel.name === "voice");

  assert.equal(member.action, "reuse");
  assert.equal(member.targetId, "t1");
  assert.equal(voice.action, "reuse");
  assert.equal(voice.targetId, "tc2");
  assert.equal(plan.stats.roles.create, 1);
});

test("drops permission overwrites that point at roles which can't be copied", () => {
  const plan = planReplication(source(), makeSnapshot());
  const rules = plan.channels.find((channel) => channel.name === "rules");

  assert.deepEqual(rules.overwrites, [
    { type: "role", id: "1000", allow: "0", deny: "2048" },
  ]);
  assert.equal(rules.droppedOverwrites, 1);
  assert.ok(plan.warnings.some((warning) => warning.includes("permission overwrite")));
  assert.ok(plan.warnings.some((warning) => warning.includes("BotFriend")));
});

test("does not reuse managed roles in the target either", () => {
  const plan = planReplication(source(), makeSnapshot({ roles: [makeRole({ name: "BotFriend", managed: true })] }));

  assert.equal(plan.roles.find((role) => role.name === "BotFriend").action, "skip");
});

test("plans server setting changes only when they differ", () => {
  const target = makeSnapshot({ name: "Preview", settings: { afkTimeout: 300 } });
  const plan = planReplication(source(), target);

  const name = plan.settings.find((setting) => setting.key === "name");
  assert.equal(name.from, "Preview");
  assert.equal(name.value, "Source");
  assert.equal(plan.settings.some((setting) => setting.key === "afkTimeout"), false);
});

test("counts messages only for text channels", () => {
  const plan = planReplication(source(), makeSnapshot(), { maxMessages: 25 });

  assert.equal(plan.channels.find((channel) => channel.name === "rules").messages, 25);
  assert.equal(plan.channels.find((channel) => channel.name === "voice").messages, 0);
  assert.equal(plan.stats.messages, 25);
});
