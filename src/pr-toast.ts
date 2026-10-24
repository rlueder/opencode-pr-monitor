import type { SessionTextEnded } from "@opencode/client";
import type { ToastOptions } from "@opencode/plugin/tui/context";
import type { Plugin } from "@opencode/plugin/tui";
import { parsePR } from "./types.ts";

export const TOAST_HISTORY_LIMIT = 2_000;

// Match a whole URL token before parsing, so lookalike hosts and path suffixes
// cannot be mistaken for a supported PR. Markdown delimiters end the token.
export function mentionedPRs(text: string): string[] {
  const urls = new Set<string>();
  for (const token of text.matchAll(/https:\/\/[^\s<>"'`\[\]()]+/gi)) {
    const candidate = token[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.port ||
        url.username ||
        url.password
      )
        continue;
      urls.add(parsePR(`https://github.com${url.pathname}`).url);
    } catch {
      // Unsupported or malformed URLs are ordinary chat, not plugin errors.
    }
  }
  return [...urls];
}

export interface ToastHistory {
  seen: string[];
}

export interface ToastBoundary {
  startedAt: number;
  history: ToastHistory;
  update: (mutation: (history: ToastHistory) => void) => void;
  show: (toast: ToastOptions) => void;
}

export function setupToasts(context: {
  data: Pick<Plugin.Context["data"], "on">;
  storage: Pick<Plugin.Context["storage"], "memory">;
  ui: Pick<Plugin.Context["ui"], "toast">;
}): () => void {
  const startedAt = Date.now();
  const [history, update] = context.storage.memory("pr-mentions/actions-v1", {
    initial: { seen: [] as string[] },
  });
  return watchPRMentions(
    (handler) => context.data.on("session.text.ended", handler),
    {
      startedAt,
      history,
      update,
      show: (toast) => context.ui.toast.show(toast),
    },
  );
}

export function watchPRMentions(
  subscribe: (handler: (event: SessionTextEnded) => void) => () => void,
  boundary: ToastBoundary,
): () => void {
  return subscribe((event) => notifyPRMentions(event, boundary));
}

export function notifyPRMentions(
  event: Pick<SessionTextEnded, "created" | "data">,
  boundary: ToastBoundary,
): void {
  if (event.created < boundary.startedAt) return;
  for (const url of mentionedPRs(event.data.text)) {
    const key = JSON.stringify([event.data.sessionID, url]);
    if (boundary.history.seen.includes(key)) continue;
    boundary.show({
      title: "Pull request mentioned",
      message: `${url}\nEnable monitoring: /pr-monitor on ${url}`,
      variant: "info",
      duration: 10_000,
      sessionID: event.data.sessionID,
    });
    boundary.update((history) => {
      history.seen.push(key);
      if (history.seen.length > TOAST_HISTORY_LIMIT)
        history.seen.splice(0, history.seen.length - TOAST_HISTORY_LIMIT);
    });
  }
}
