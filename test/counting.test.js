import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCountingStore, parseCount } from "../src/lib/counting.js";

function message(
  content,
  { userId = "u1", channelId = "c1", bot = false, webhookId = null, system = false } = {},
) {
  return {
    guild: { id: "g1" },
    guildId: "g1",
    channelId,
    content,
    system,
    webhookId,
    author: { id: userId, bot },
  };
}

function store() {
  return createCountingStore({ guildId: "g1" });
}

test("only plain digits count as a number", () => {
  assert.equal(parseCount("5"), 5);
  assert.equal(parseCount(" 12 "), 12);
  assert.equal(parseCount("100000"), 100000);

  for (const value of ["", "   ", "5!", "five", "-1", "1.5", "5 6", undefined, "9".repeat(20)]) {
    assert.equal(parseCount(value), null, `${JSON.stringify(value)} is not a number`);
  }
});

test("nothing is counted until a channel is set, and other channels are ignored", () => {
  const counting = store();
  assert.equal(counting.handleMessage(message("1")).action, "ignored");

  counting.setChannel("g1", "c1");
  assert.equal(counting.handleMessage(message("1", { channelId: "c2" })).action, "ignored");
  assert.equal(counting.settings().count, 0);
});

test("the chain only advances on the next number", () => {
  const counting = store();
  counting.setChannel("g1", "c1");

  const first = counting.handleMessage(message("1", { userId: "u1" }));
  assert.equal(first.action, "counted");
  assert.equal(first.count, 1);
  assert.equal(first.next, 2);

  const second = counting.handleMessage(message("2", { userId: "u2" }));
  assert.equal(second.count, 2);
  assert.equal(counting.settings().next, 3);
});

test("a wrong number resets the chain but keeps the record", () => {
  const counting = store();
  counting.setChannel("g1", "c1");
  counting.handleMessage(message("1", { userId: "u1" }));
  counting.handleMessage(message("2", { userId: "u2" }));

  const broken = counting.handleMessage(message("5", { userId: "u3" }));
  assert.equal(broken.action, "reset");
  assert.equal(broken.reason, "wrong-number");
  assert.equal(broken.expected, 3);
  assert.equal(broken.got, 5);
  assert.equal(broken.previous, 2);
  assert.equal(broken.record, 2);
  assert.equal(broken.ruinedBy, "u3");

  assert.equal(counting.settings().count, 0);
  assert.equal(counting.settings().next, 1);
  assert.equal(counting.settings().record, 2);
});

test("the same person can't count twice in a row", () => {
  const counting = store();
  counting.setChannel("g1", "c1");
  counting.handleMessage(message("1", { userId: "u1" }));

  const twice = counting.handleMessage(message("2", { userId: "u1" }));
  assert.equal(twice.action, "reset");
  assert.equal(twice.reason, "same-user");
  assert.equal(twice.got, 2);

  // Starting over, the same person may open the new chain.
  assert.equal(counting.handleMessage(message("1", { userId: "u1" })).action, "counted");
});

test("bots, webhooks, system notes and chatter never count", () => {
  const counting = store();
  counting.setChannel("g1", "c1");

  assert.equal(counting.handleMessage(message("1", { bot: true })).action, "ignored");
  assert.equal(counting.handleMessage(message("1", { webhookId: "w1" })).action, "ignored");
  assert.equal(counting.handleMessage(message("1", { system: true })).action, "ignored");
  assert.equal(counting.handleMessage(message("nice one")).action, "ignored");
  assert.equal(counting.settings().count, 0);
});

test("switching channels starts over; disabling stops counting", () => {
  const counting = store();
  counting.setChannel("g1", "c1");
  counting.handleMessage(message("1"));
  counting.handleMessage(message("2", { userId: "u2" }));

  const moved = counting.setChannel("g1", "c2");
  assert.equal(moved.count, 0);
  assert.equal(moved.record, 2);
  assert.equal(counting.handleMessage(message("1", { channelId: "c1" })).action, "ignored");

  counting.setChannel("g1", "c2");
  assert.equal(counting.handleMessage(message("1", { channelId: "c2" })).action, "counted");

  counting.disable("g1");
  assert.equal(counting.handleMessage(message("2", { channelId: "c2" })).action, "ignored");
  assert.equal(counting.settings().enabled, false);
});

test("the count and record survive a restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "counting-"));
  const file = join(directory, "counting.json");

  try {
    const first = createCountingStore({ file, guildId: "g1" });
    first.setChannel("g1", "c1");
    first.handleMessage(message("1"));
    first.handleMessage(message("2", { userId: "u2" }));
    first.handleMessage(message("3", { userId: "u3" }));

    const second = createCountingStore({ file, guildId: "g1" });
    assert.equal(second.settings().channelId, "c1");
    assert.equal(second.settings().count, 3);
    assert.equal(second.settings().record, 3);
    assert.equal(second.settings().lastUserId, "u3");

    const broken = second.handleMessage(message("7", { userId: "u1" }));
    assert.equal(broken.action, "reset");

    const third = createCountingStore({ file, guildId: "g1" });
    assert.equal(third.settings().count, 0);
    assert.equal(third.settings().record, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
