import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { NotificationView } from "../src/notification-view.tsx";

const source = process.argv[2];
assert.ok(source, "Pass the actual ghost plugin's src/ghost.ts path");
// OpenCode supplies one shared OpenTUI to plugins. Reproduce that boundary even
// when the two development checkouts have different installed SDK versions.
const core = fileURLToPath(import.meta.resolve("@opentui/core"));
const build = await Bun.build({
  entrypoints: [resolve(source)],
  target: "bun",
  format: "esm",
  packages: "external",
});
assert.ok(
  build.success,
  "Could not bundle the actual ghost plugin for the shared test host",
);
const compiled = (await build.outputs[0].text()).replace(
  /\bfrom\s+(["'])@opentui\/core\1/g,
  `from ${JSON.stringify(pathToFileURL(core).href)}`,
);
const cache = resolve("node_modules/.cache");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "ghost-integration-"));
const modulePath = join(temp, "ghost.mjs");
let createGhost;
try {
  await writeFile(modulePath, compiled);
  ({ createGhost } = await import(pathToFileURL(modulePath).href));
} finally {
  await unlink(modulePath).catch(() => {});
  await rmdir(temp);
}
assert.equal(typeof createGhost, "function");

const url = "https://github.com/owner/repo/pull/42";
const color = RGBA.fromHex("#eeeeee");
const button = {
  base: color,
  hovered: color,
  pressed: color,
  disabled: color,
  selected: color,
  focused: color,
  state: () => color,
};
const [notices, setNotices] = createSignal([
  {
    key: "test",
    sessionID: "ses_test",
    directory: "/test",
    url,
    status: { enabled: false, url: null },
    busy: false,
    error: null,
  },
]);
const [editorRow, setEditorRow] = createSignal(0);
let editor;
const view = await testRender(
  () => (
    <box width="100%" height="100%">
      <box
        position="absolute"
        top={editorRow()}
        left={0}
        width="100%"
        height={1}
        zIndex={1000}
      >
        <textarea
          ref={(node) => {
            editor = node;
            editor.traits = {
              owner: "opencode",
              role: "prompt",
              capture: ["tab"],
            };
          }}
          focused
          width="100%"
          height={1}
          placeholder="Ask anything"
          backgroundColor="#44475a"
          focusedBackgroundColor="#44475a"
        />
      </box>
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
        act={async () => {}}
        refresh={async () => {}}
        dismiss={() => setNotices([])}
      />
    </box>
  ),
  { width: 100, height: 32 },
);
let ghost;
try {
  const frame = await view.waitForFrame((value) => value.includes("[Turn on]"));
  const rows = frame.split("\n");
  const y = rows.findIndex((row) => row.includes("[Turn on]"));
  const x = rows[y].indexOf("[Turn on]") + 2;
  setEditorRow(y);
  await view.flush();
  assert.ok(editor);
  editor.focus();
  ghost = createGhost({
    renderer: view.renderer,
    suggestion: () => "check the PR for merge conflicts",
    enabled: () => true,
    color: RGBA.fromHex("#6272a4"),
    background: RGBA.fromHex("#44475a"),
  });
  await view.flush();
  assert.ok(
    view.captureCharFrame().split("\n")[y].includes("[Turn on]"),
    "Actual ghost painter must not overwrite the toast on the same editor row",
  );
  assert.equal(
    ghost.available(),
    false,
    "A partially covered suggestion cannot be accepted",
  );
  assert.equal(ghost.accept(), false);
  assert.equal(editor.plainText, "");
  const dismissX =
    view.captureCharFrame().split("\n")[y].indexOf("[Dismiss]") + 2;
  assert.ok(dismissX > x);
  await view.mockMouse.click(dismissX, y);
  await view.flush();
  await view.waitForFrame(
    (value) =>
      !value.includes("Pull request mentioned") &&
      value.includes("check the PR for merge conflicts"),
  );
  assert.ok(editor.focused);
  assert.equal(ghost.available(), true);
  ghost.accept();
  assert.equal(editor.plainText, "check the PR for merge conflicts");
  console.log(
    "Actual ghost-plugin integration: overlay composition, hidden-accept guard, dismiss and restored suggestion passed.",
  );
} finally {
  ghost?.dispose();
  await view.dispose();
}
