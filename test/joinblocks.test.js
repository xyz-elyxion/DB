import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../src/lib/errors.js";
import { startJoinServer } from "../src/lib/join.js";
import { createJoinBlockStore } from "../src/lib/joinblocks.js";

test("a block replaces any earlier one for the same user", () => {
  const store = createJoinBlockStore();

  store.block({ guildId: "g1", userId: "u1", reason: "spam", moderatorId: "mod1" });
  const updated = store.block({ guildId: "g1", userId: "u1", reason: "raiding", moderatorId: "mod2" });

  assert.equal(store.count, 1);
  assert.equal(updated.reason, "raiding");
  assert.equal(store.get("g1", "u1").moderatorId, "mod2");
  assert.equal(store.get("g1", "u1").guildId, "g1");
  assert.ok(store.get("g1", "u1").at);
});

test("blocks are per server and can be lifted", () => {
  const store = createJoinBlockStore();
  store.block({ guildId: "g1", userId: "u1", reason: "spam" });

  assert.equal(store.get("g2", "u1"), null, "another server isn't affected");
  assert.deepEqual(store.list("g1").map((entry) => entry.userId), ["u1"]);
  assert.deepEqual(store.list("g2"), []);

  assert.equal(store.lift("g1", "u1"), true);
  assert.equal(store.lift("g1", "u1"), false);
  assert.equal(store.count, 0);
});

test("blocks survive a restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "joinblocks-"));
  const file = join(directory, "blocks.json");

  try {
    const first = createJoinBlockStore({ file });
    first.block({ guildId: "g1", userId: "u1", reason: "raiding the preview" });

    const second = createJoinBlockStore({ file });
    assert.equal(second.get("g1", "u1").reason, "raiding the preview");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the join page refuses a blocked person and shows the reason", async () => {
  const flow = {
    async complete() {
      throw new UserError(
        "You're blocked from joining Main from the preview. Reason: raiding the preview",
      );
    },
  };

  const server = startJoinServer({ flow, port: 0, path: "/join/callback" });
  await once(server, "listening");
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/join/callback?code=abc&state=st`);
    assert.equal(response.status, 403);

    const body = await response.text();
    assert.match(body, /You can&#39;t join|You can't join/);
    assert.match(body, /raiding the preview/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
