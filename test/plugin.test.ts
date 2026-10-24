import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.ts";

test("published V2 package loads the native Plugin.define entrypoint without starting a service", () => {
  assert.equal(plugin.id, "opencode.pr-monitor");
  assert.equal(typeof plugin.setup, "function");
  assert.equal("server" in plugin, false);
});
