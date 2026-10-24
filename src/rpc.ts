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
