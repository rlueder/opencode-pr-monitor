import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEnable, ENABLE_ACTION } from "../src/permission.ts";

const url = "https://github.com/acme/project/pull/42";
type Assert = Parameters<typeof assertEnable>[0]["assert"];

test("enable asserts only pr-monitor.enable on the PR URL and resolves when the host allows it", async () => {
  const requests: Parameters<Assert>[0][] = [];
  // An `allow` rule makes the host resolve without showing a prompt.
  const permission = {
    assert: async (input: Parameters<Assert>[0]) => {
      requests.push(input);
    },
  };
  await assertEnable(permission, "ses_one", url, new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.action, ENABLE_ACTION);
  assert.equal(ENABLE_ACTION, "pr-monitor.enable");
  assert.deepEqual(requests[0]?.resources, [url]);
  assert.equal(requests[0]?.sessionID, "ses_one");
});

test("enable still honours a deny or rejection from the host", async () => {
  const permission = {
    assert: async () => {
      throw new Error("Denied by rule");
    },
  };
  await assert.rejects(
    assertEnable(permission, "ses_one", url, new AbortController().signal),
    /Denied by rule/,
  );
});

test("enable stops waiting for an unanswered prompt on abort", async () => {
  const controller = new AbortController();
  const permission = { assert: () => new Promise<void>(() => {}) };
  const pending = assertEnable(permission, "ses_one", url, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  controller.abort();
  await assert.rejects(
    assertEnable(permission, "ses_one", url, controller.signal),
    /cancelled/,
  );
});
