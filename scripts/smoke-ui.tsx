import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal } from "solid-js";
import type { StatefulColor } from "@opencode/theme/tui";
import { NotificationView } from "../src/notification-view.tsx";
import { Notifications, type Notification } from "../src/notification.ts";
import { notifyPRMentions, type ToastBoundary } from "../src/pr-toast.ts";

const url = "https://github.com/owner/repo/pull/42";
const color = RGBA.fromHex("#cccccc");
const hover = RGBA.fromHex("#eeeeee");
const pressed = RGBA.fromHex("#999999");
const disabled = RGBA.fromHex("#555555");
const button: StatefulColor = {
  base: color,
  hovered: hover,
  pressed,
  disabled,
  selected: color,
  focused: color,
  state: (state) =>
    state.disabled
      ? disabled
      : state.pressed
        ? pressed
        : state.hovered
          ? hover
          : color,
};
const [notices, setNotices] = createSignal<Notification[]>([]);
const actions: boolean[] = [];
let enabled = false;
const notifications = new Notifications({
  changed: (items) => setNotices(items),
  status: async () => ({ enabled, url }),
  command: async (_notice, text) => {
    enabled = text.startsWith("on ");
    actions.push(enabled);
  },
});
const boundary: ToastBoundary = {
  startedAt: 0,
  history: { seen: [] },
  update: (mutate) => mutate(boundary.history),
  show: (toast) =>
    notifications.add(
      toast.sessionID ?? "",
      toast.message.split("\n")[0] ?? "",
      "/test",
    ),
};
function mention(messageID: string) {
  notifyPRMentions(
    {
      id: `evt_${messageID}`,
      type: "session.text.ended",
      created: Date.now(),
      durable: { aggregateID: "ses_test", seq: 1, version: 1 },
      data: {
        sessionID: "ses_test",
        assistantMessageID: messageID,
        ordinal: 0,
        text: url,
      },
    },
    boundary,
  );
}
const view = await testRender(
  () => (
    <NotificationView
      theme={{
        text: { base: color, muted: color, action: { secondary: button } },
        border: { base: color },
        background: {
          raised: { base: RGBA.fromHex("#222222") },
          action: { secondary: button },
        },
      }}
      notices={notices()}
      act={(key, value) => notifications.act(key, value)}
      refresh={(key) => notifications.refresh(key)}
      dismiss={(key) => notifications.dismiss(key)}
    />
  ),
  { width: 100, height: 32 },
);

try {
  mention("message_one");
  async function click(label: string, button: 0 | 2 = 0) {
    const frame = await view.waitForFrame((value) => value.includes(label));
    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    const x = lines[y]?.indexOf(label) ?? -1;
    assert.ok(x >= 0 && y >= 0, `Missing control: ${label}`);
    await view.mockMouse.click(x + 2, y, button);
    await view.flush();
  }
  await view.waitForFrame((frame) => frame.includes("Monitoring is off"));
  const initial = JSON.stringify(view.captureSpans());
  const frame = view.captureCharFrame().split("\n");
  const buttonY = frame.findIndex((line) => line.includes("[Turn on]"));
  const buttonX = (frame[buttonY]?.indexOf("[Turn on]") ?? -1) + 2;
  assert.ok(buttonX >= 2 && buttonY >= 0);
  await view.mockMouse.moveTo(buttonX, buttonY);
  await view.flush();
  assert.notEqual(
    JSON.stringify(view.captureSpans()),
    initial,
    "Hover changes the rendered button colors",
  );
  await view.mockMouse.moveTo(0, 0);
  await view.flush();
  assert.equal(
    JSON.stringify(view.captureSpans()),
    initial,
    "Mouse leave restores the button colors",
  );
  await click("[Turn on]", 2);
  assert.deepEqual(actions, []);
  setNotices((items) => items.map((item) => ({ ...item, busy: true })));
  await view.waitForFrame((value) => value.includes("Working…"));
  await click("[Turn on]");
  assert.deepEqual(actions, [], "Disabled controls ignore clicks");
  setNotices((items) => items.map((item) => ({ ...item, busy: false })));
  await view.waitForFrame((value) => value.includes("Monitoring is off"));
  await click("[Turn on]");
  await view.waitForFrame(
    (frame) =>
      frame.includes("Monitoring is on") && frame.includes("[Turn off]"),
  );
  assert.deepEqual(actions, [true]);
  await click("[Turn off]");
  await view.waitForFrame((frame) => frame.includes("Monitoring is off"));
  assert.deepEqual(actions, [true, false]);
  view.resize(50, 24);
  await view.waitForFrame(
    (frame) => frame.includes("[Dismiss]") && frame.includes("[Turn on]"),
  );
  await click("[Dismiss]");
  await view.waitForFrame((frame) => !frame.includes("Pull request mentioned"));
  mention("message_one");
  await view.flush();
  assert.ok(
    !view.captureCharFrame().includes("Pull request mentioned"),
    "Replayed message stays dismissed",
  );
  mention("message_two");
  await view.waitForFrame(
    (frame) =>
      frame.includes("Pull request mentioned") && frame.includes("[Turn on]"),
  );
  assert.deepEqual(
    actions,
    [true, false],
    "New mention only reopens the controls",
  );
  console.log(
    "Headless TUI smoke: render, hover/leave, on/off clicks, disabled/right-click guards, resize, dismiss, replay suppression and new-message reopening passed.",
  );
} finally {
  notifications.close();
  await view.dispose();
}
