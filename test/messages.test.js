import test from "node:test";
import assert from "node:assert/strict";
import { splitContent, webhookName } from "../src/lib/messages.js";

test("short content stays in one chunk", () => {
  assert.deepEqual(splitContent("hello"), ["hello"]);
  assert.deepEqual(splitContent("   "), ["   "]);
  assert.deepEqual(splitContent(""), []);
});

test("long content is split under 2000 characters", () => {
  const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
  const chunks = splitContent(text);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000, `chunk is ${chunk.length} chars`);
  assert.equal(chunks.join("\n"), text);
});

test("webhook names drop the reserved words and fit the limit", () => {
  assert.equal(webhookName({ displayName: "Discord Fan" }), "member Fan");
  assert.equal(webhookName({ displayName: "Clyde" }), "member");
  assert.equal(webhookName({ displayName: "x".repeat(80) }).length, 32);
  assert.equal(webhookName(undefined), "member");
});
