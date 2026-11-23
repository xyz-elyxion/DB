import test from "node:test";
import assert from "node:assert/strict";
import { readBoolean } from "../src/config.js";

test("boolean env values are read generously", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on", "enabled", "y", "t"]) {
    assert.equal(readBoolean(value), true, `${JSON.stringify(value)} should be on`);
  }
});

test("quoted and padded values still count as on", () => {
  for (const value of ['"true"', "'true'", ' "on" ', ' "yes"', "true\r"]) {
    assert.equal(readBoolean(value), true, `${JSON.stringify(value)} should be on`);
  }
});

test("mirroring is on unless it is explicitly turned off", () => {
  assert.equal(readBoolean(undefined, true), true);
  assert.equal(readBoolean("", true), true);
  assert.equal(readBoolean("false", true), false);
  assert.equal(readBoolean("0", true), false);
});

test("off values are off, and unknown values fall back", () => {
  for (const value of ["0", "false", "FALSE", " no ", "off", "disabled"]) {
    assert.equal(readBoolean(value), false, `${JSON.stringify(value)} should be off`);
  }

  assert.equal(readBoolean("maybe"), false);
  assert.equal(readBoolean("maybe", true), true);
  assert.equal(readBoolean(undefined), false);
  assert.equal(readBoolean(undefined, true), true);
  assert.equal(readBoolean(""), false);
  assert.equal(readBoolean("   ", true), true, "blank keeps the fallback");
  assert.equal(readBoolean("   "), false);
});
