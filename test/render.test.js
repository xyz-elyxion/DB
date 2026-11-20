import test from "node:test";
import assert from "node:assert/strict";
import { makeChannel, makeRole, makeSnapshot } from "./fixtures.js";
import { planReplication } from "../src/lib/planner.js";
import { buildChannelTree, renderPreview, renderProgress, renderResult, truncate } from "../src/lib/render.js";

function plan() {
  return planReplication(
    makeSnapshot({
      roles: [makeRole({ id: "r1", name: "Admin", permissions: "8" })],
      channels: [
        makeChannel({ id: "cat1", name: "INFO", type: "category" }),
        makeChannel({ id: "ch1", name: "rules", parentId: "cat1" }),
        makeChannel({ id: "ch2", name: "Lounge", type: "voice" }),
      ],
    }),
    makeSnapshot({ id: "2000", name: "Preview", settings: {} }),
  );
}

test("tree lists categories, nested channels and orphans", () => {
  const tree = buildChannelTree(plan());

  assert.match(tree, /\+ INFO/);
  assert.match(tree, /# rules/);
  assert.match(tree, /🔊 Lounge/);
});

test("tree is capped with a count of the rest", () => {
  const wide = planReplication(
    makeSnapshot({ channels: Array.from({ length: 50 }, (_, index) => makeChannel({ id: `c${index}`, name: `chan-${index}` })) }),
    makeSnapshot({ id: "2000" }),
  );
  const tree = buildChannelTree(wide, { maxLines: 5 });

  assert.equal(tree.split("\n").length, 6);
  assert.match(tree, /and 45 more/);
});

test("preview embed reports counts and makes clear nothing changed", () => {
  const embed = renderPreview(plan()).data;

  assert.match(embed.title, /Preview: Source → Preview/);
  assert.match(embed.footer.text, /nothing was changed/);
  assert.ok(embed.fields.some((field) => field.name === "Roles"));
  assert.match(embed.fields.find((field) => field.name === "Roles").value, /1 to create/);
});

test("result embed summarises the run", () => {
  const embed = renderResult(
    plan(),
    {
      rolesCreated: 2,
      rolesUpdated: 0,
      rolesReused: 0,
      channelsCreated: 3,
      channelsUpdated: 0,
      emojisCreated: 0,
      settingsApplied: 0,
      messagesCopied: 0,
      skipped: [],
      warnings: [],
      errors: ["#rules: Missing Permissions"],
    },
    { durationMs: 4200 },
  ).data;

  assert.match(embed.title, /Replicated with errors/);
  assert.equal(embed.fields[0].name, "Created");
  assert.ok(embed.fields.some((field) => field.name.includes("Errors")));
  assert.match(embed.footer.text, /4s/);
});

test("progress embed includes the bar and the current step", () => {
  const embed = renderProgress(3, 10, "#rules").data;

  assert.match(embed.description, /3\/10/);
  assert.match(embed.description, /#rules/);
});

test("truncate never exceeds the Discord field limit", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("a".repeat(50), 10).length, 10);
});
