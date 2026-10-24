import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import type { StatefulColor } from "@opencode/theme/tui";
import { NotificationView } from "../src/notification-view.tsx";

// These are sample inputs to the real component, not a live monitoring claim.
const url = "https://github.com/rlueder/opencode-pr-monitor/pull/1";
const rgba = (hex: string) => RGBA.fromHex(hex);
function states(
  base: string,
  hover: string,
  pressed: string,
  disabled: string,
): StatefulColor {
  const colors = {
    base: rgba(base),
    hovered: rgba(hover),
    pressed: rgba(pressed),
    disabled: rgba(disabled),
    focused: rgba(hover),
    selected: rgba(hover),
  };
  return {
    ...colors,
    state: (state) =>
      state.disabled
        ? colors.disabled
        : state.pressed
          ? colors.pressed
          : state.hovered
            ? colors.hovered
            : colors.base,
  };
}
const background = "#282a36";
const view = await testRender(
  () => (
    <NotificationView
      theme={{
        text: {
          base: rgba("#f8f8f2"),
          muted: rgba("#a7a9bd"),
          action: {
            secondary: states("#f8f8f2", "#282a36", "#f8f8f2", "#6272a4"),
          },
        },
        border: { base: rgba("#6272a4") },
        background: {
          raised: { base: rgba(background) },
          action: {
            secondary: states("#44475a", "#bd93f9", "#71549b", "#343746"),
          },
        },
      }}
      notices={[
        {
          key: "capture",
          sessionID: "ses_sample",
          url,
          directory: "/sample",
          status: { enabled: true, url },
          busy: false,
          error: null,
        },
      ]}
      act={async () => {}}
      refresh={async () => {}}
      dismiss={() => {}}
    />
  ),
  { width: 100, height: 28 },
);

try {
  const frame = await view.waitForFrame((value) =>
    value.includes("[Turn off]"),
  );
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes("[Turn off]"));
  const x = (lines[y]?.indexOf("[Turn off]") ?? -1) + 2;
  if (x < 2 || y < 0) throw new Error("Toast control did not render");
  await view.mockMouse.moveTo(x, y);
  await view.flush();
  const capture = view.captureSpans();
  const textLines = capture.lines.map((line) =>
    line.spans.map((span) => span.text).join(""),
  );
  const used = textLines
    .map((line, row) => ({ line, row }))
    .filter(({ line }) => line.trim());
  if (!used.length) throw new Error("Empty toast capture");
  const left = Math.max(
    0,
    Math.min(...used.map(({ line }) => line.search(/\S/))) - 1,
  );
  const right = Math.min(
    capture.cols,
    Math.max(...used.map(({ line }) => line.trimEnd().length)) + 1,
  );
  const top = Math.max(0, (used[0]?.row ?? 0) - 1);
  const bottom = Math.min(capture.rows, (used.at(-1)?.row ?? 0) + 2);
  const cellWidth = 10;
  const cellHeight = 24;
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const color = (value: RGBA) => {
    const [r, g, b] = value.toInts();
    return `rgb(${r},${g},${b})`;
  };
  const cells: string[] = [];
  for (let row = top; row < bottom; row++) {
    let col = 0;
    for (const span of capture.lines[row]?.spans ?? []) {
      const px = col * cellWidth;
      const py = row * cellHeight;
      const width = span.width * cellWidth;
      if (span.bg.a > 0)
        cells.push(
          `<rect x="${px}" y="${py}" width="${width}" height="${cellHeight}" fill="${color(span.bg)}"/>`,
        );
      if (span.text.trim())
        cells.push(
          `<text x="${px}" y="${py + 18}" textLength="${width}" lengthAdjust="spacingAndGlyphs" fill="${color(span.fg)}" xml:space="preserve">${escape(span.text)}</text>`,
        );
      col += span.width;
    }
  }
  const width = (right - left) * cellWidth;
  const height = (bottom - top) * cellHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left * cellWidth} ${top * cellHeight} ${width} ${height}">
<title>OpenCode PR monitor: actual component capture with sample monitoring state</title>
<rect x="${left * cellWidth}" y="${top * cellHeight}" width="${width}" height="${height}" fill="${background}"/>
<g font-family="Menlo,DejaVu Sans Mono,monospace" font-size="16">${cells.join("\n")}</g>
</svg>`;
  const output = new URL("../docs/images/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL("pr-toast.svg", output), svg);
  const png = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Menlo" },
    fitTo: { mode: "zoom", value: 2 },
  })
    .render()
    .asPng();
  await writeFile(new URL("pr-toast.png", output), png);
  console.log(
    `Captured actual toast component: ${fileURLToPath(new URL("pr-toast.png", output))}`,
  );
} finally {
  await view.dispose();
}
