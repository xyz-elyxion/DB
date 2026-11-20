import test from "node:test";
import assert from "node:assert/strict";
import { fakeGuild, makeChannel, makeRole, makeSnapshot } from "./fixtures.js";
import { applyPlan } from "../src/lib/builder.js";
import { planReplication } from "../src/lib/planner.js";

function source() {
  return makeSnapshot({
    roles: [
      makeRole({ id: "r1", name: "Admin", position: 2, permissions: "8", color: 0xff0000 }),
      makeRole({ id: "r2", name: "Member", position: 1, permissions: "1024" }),
    ],
    channels: [
      makeChannel({ id: "cat1", name: "INFO", type: "category", position: 0 }),
      makeChannel({
        id: "ch1",
        name: "rules",
        parentId: "cat1",
        position: 0,
        overwrites: [
          { type: "role", id: "r1", allow: "1024", deny: "0" },
          { type: "member", id: "999", allow: "1024", deny: "0" },
        ],
      }),
      makeChannel({ id: "ch2", name: "Lounge", type: "voice", position: 2 }),
    ],
  });
}

function run(options = {}) {
  const target = fakeGuild();
  const plan = planReplication(source(), makeSnapshot({ id: target.id, name: target.name }), options);
  return applyPlan({
    plan,
    targetGuild: target,
    options: { delayMs: 0 },
  }).then((report) => ({ report, plan, target }));
}

test("creates roles with their permissions and colours", async () => {
  const { report, target } = await run();

  assert.equal(report.rolesCreated, 2);
  assert.deepEqual(
    target.createdRoles.map((role) => [role.name, role.color, String(role.permissions.bitfield)]),
    [
      ["Admin", 0xff0000, "8"],
      ["Member", 0, "1024"],
    ],
  );
});

test("creates categories before channels and nests children under them", async () => {
  const { target } = await run();

  assert.deepEqual(
    target.createdChannels.map((channel) => channel.name),
    ["INFO", "rules", "Lounge"],
  );

  const category = target.createdChannels[0];
  const rules = target.createdChannels[1];
  assert.equal(rules.parentId, category.id);
  assert.equal(rules.topic, null);
  assert.equal("topic" in rules.payload, false);
  assert.equal(target.createdChannels[2].parentId, null);
});

test("remaps role permission overwrites to the newly created roles", async () => {
  const { target } = await run();
  const rules = target.createdChannels.find((channel) => channel.name === "rules");
  const admin = target.createdRoles.find((role) => role.name === "Admin");

  assert.deepEqual(rules.payload.permissionOverwrites, [
    { id: admin.id, allow: 1024n, deny: 0n },
  ]);
});

test("skips member overwrites for people who aren't in the target", async () => {
  const { report, target } = await run();
  const rules = target.createdChannels.find((channel) => channel.name === "rules");

  assert.equal(rules.payload.permissionOverwrites.length, 1);
  assert.ok(report.warnings.some((warning) => warning.includes("members who aren't")));
});

test("applies the source channel position", async () => {
  const { target } = await run();
  const lounge = target.createdChannels.find((channel) => channel.name === "Lounge");

  assert.equal(lounge.position, 2);
});

test("renames the target when settings copying is on", async () => {
  const { report, target } = await run();

  assert.equal(target.name, "Source");
  assert.equal(report.settingsApplied, 1);
});

test("reuses and updates an existing role instead of creating it", async () => {
  const target = fakeGuild();
  const existing = {
    id: "existing-role",
    name: "Admin",
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: { bitfield: 0n },
    position: 1,
    managed: false,
    edits: [],
    async edit(changes) {
      Object.assign(existing, changes);
      existing.edits.push(changes);
    },
    async setPosition(position) {
      existing.position = position;
    },
  };
  target.roles.cache.set(existing.id, existing);

  const plan = planReplication(
    source(),
    makeSnapshot({
      id: target.id,
      name: target.name,
      roles: [makeRole({ id: "existing-role", name: "Admin", permissions: "0", color: 0 })],
    }),
  );
  const report = await applyPlan({ plan, targetGuild: target, options: { delayMs: 0 } });

  assert.equal(report.rolesCreated, 1);
  assert.equal(report.rolesUpdated, 1);
  assert.equal(existing.color, 0xff0000);
});
