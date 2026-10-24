import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifications, type Notification } from "../src/notification.ts";
import { decodeStatus, type MonitorStatus } from "../src/rpc.ts";

const url = "https://github.com/owner/repo/pull/42";
const other = "https://github.com/owner/repo/pull/43";
const key = JSON.stringify(["ses_one", url]);
const directory = "/project";

function harness() {
  let state: MonitorStatus = { enabled: false, url: null };
  let shown: Notification[] = [];
  const commands: string[] = [];
  const ports = {
    status: async (_notice: Notification, _signal: AbortSignal) => state,
    command: async (
      _notice: Notification,
      text: string,
      _signal: AbortSignal,
    ) => {
      commands.push(text);
      state = { enabled: text.startsWith("on "), url };
    },
    changed: (value: Notification[]) => {
      shown = value;
    },
  };
  const notifications = new Notifications(ports);
  return {
    notifications,
    ports,
    commands,
    shown: () => shown,
    setStatus: (value: MonitorStatus) => {
      state = value;
    },
  };
}

async function ready() {
  const h = harness();
  h.notifications.add("ses_one", url, directory);
  // Wait for the initial read, not a timer or a model call.
  await Promise.resolve();
  return h;
}

test("mention reads server status but never enables monitoring", async () => {
  const h = await ready();
  assert.equal(h.shown()[0]?.status?.enabled, false);
  assert.deepEqual(h.commands, []);
});

test("explicit on/off actions call existing commands and confirm server status", async () => {
  const h = await ready();
  await h.notifications.act(key, true);
  assert.deepEqual(h.commands, [`on ${url}`]);
  assert.equal(h.shown()[0]?.status?.enabled, true);
  await h.notifications.act(key, false);
  assert.deepEqual(h.commands, [`on ${url}`, "off"]);
  assert.equal(h.shown()[0]?.status?.enabled, false);
});

test("permission errors leave a retryable notification, not a false on state", async () => {
  const h = await ready();
  h.ports.command = async () => {
    throw new Error("Permission denied");
  };
  await h.notifications.act(key, true);
  assert.equal(h.shown()[0]?.busy, false);
  assert.equal(h.shown()[0]?.status?.enabled, false);
  assert.equal(h.shown()[0]?.error, "Permission denied");
});

test("will not turn off a different PR after status changes", async () => {
  const h = await ready();
  h.setStatus({ enabled: true, url: other });
  await h.notifications.act(key, false);
  assert.deepEqual(h.commands, []);
  assert.match(h.shown()[0]?.error ?? "", /Monitoring changed/);
});

test("refresh observes external on/off changes", async () => {
  const h = await ready();
  h.setStatus({ enabled: true, url });
  await h.notifications.refreshAll();
  assert.equal(h.shown()[0]?.status?.enabled, true);
  assert.deepEqual(h.commands, []);
});

test("double click is coalesced while command/permission is pending", async () => {
  const h = await ready();
  let finish = () => {};
  h.ports.command = async () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = h.notifications.act(key, true);
  await Promise.resolve();
  assert.equal(h.shown()[0]?.busy, true);
  await h.notifications.act(key, true);
  h.setStatus({ enabled: true, url });
  finish();
  await pending;
  assert.equal(h.shown()[0]?.busy, false);
  assert.equal(h.shown()[0]?.error, null);
});

test("a command that returns without enabling is not presented as successful", async () => {
  const h = await ready();
  h.ports.command = async () => {};
  await h.notifications.act(key, true);
  assert.match(h.shown()[0]?.error ?? "", /before confirmation/);
  assert.equal(h.shown()[0]?.status?.enabled, false);
});

test("dismiss does not disable monitoring", async () => {
  const h = await ready();
  h.notifications.dismiss(key);
  assert.deepEqual(h.shown(), []);
  assert.deepEqual(h.commands, []);
});

test("bounded queue preserves session isolation and deduplicates notices", async () => {
  const h = await ready();
  h.notifications.add("ses_one", url, directory);
  h.notifications.add("ses_two", url, directory);
  assert.equal(h.shown().length, 2);
  for (let n = 3; n < 15; n++) {
    h.notifications.add(`ses_${n}`, url, directory);
    await Promise.resolve();
  }
  assert.equal(h.shown().length, 5);
});

test("unload aborts work and ignores late callbacks", async () => {
  const h = await ready();
  let signal: AbortSignal | undefined;
  let finish: ((value: MonitorStatus) => void) | undefined;
  h.ports.status = async (_notice, s) => {
    signal = s;
    return new Promise<MonitorStatus>((resolve) => {
      finish = resolve;
    });
  };
  const pending = h.notifications.act(key, true);
  const before = h.shown();
  h.notifications.close();
  assert.equal(signal?.aborted, true);
  finish?.({ enabled: false, url: null });
  await pending;
  assert.equal(h.shown(), before);
  assert.deepEqual(h.commands, []);
});

test("invalid read-only RPC responses are rejected", () => {
  assert.deepEqual(decodeStatus({ enabled: true, url }), {
    enabled: true,
    url,
  });
  for (const value of [
    null,
    {},
    { enabled: "true", url },
    { enabled: false, url: 42 },
  ])
    assert.throws(() => decodeStatus(value));
});
