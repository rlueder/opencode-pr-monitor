import { Rpc } from "@opencode/plugin/rpc";

export const MonitorUI = Rpc.define({
  id: "opencode.pr-monitor.ui",
  events: {},
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          url: { type: ["string", "null"] },
        },
        required: ["enabled", "url"],
        additionalProperties: false,
      },
    },
  },
});

// Metadata on the server's synthetic reply to `/pr-monitor`. Shared by the
// server, which sets it, and the TUI, which skips on/off replies.
export const STATUS_SOURCE = "opencode.pr-monitor.status";
export type StatusAction = "on" | "off" | "status";
export function statusAction(text: string): StatusAction {
  const command = text.trim();
  if (command === "off") return "off";
  if (command.startsWith("on ")) return "on";
  return "status";
}

export interface MonitorStatus {
  enabled: boolean;
  url: string | null;
}

export function decodeStatus(value: unknown): MonitorStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    !("url" in value) ||
    !(typeof value.url === "string" || value.url === null)
  )
    throw new Error("Invalid PR monitor status response");
  return { enabled: value.enabled, url: value.url };
}
