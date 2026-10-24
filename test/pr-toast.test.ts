import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionTextEnded, SessionInboxEnqueued } from "@opencode/client";
import type { ToastOptions } from "@opencode/plugin/tui/context";
import {
  mentionedPRs,
  notifyPRMentions,
  TOAST_HISTORY_LIMIT,
  watchPRMentions,
  type ToastBoundary,
  type ToastHistory,
  setupToasts,
  type MentionEvent,
} from "../src/pr-toast.ts";

const url = "https://github.com/owner/repo/pull/42";

function event(
  text: string,
  sessionID = "ses_one",
  created = 100,
  messageID = "msg_one",
): SessionTextEnded {
  return {
    id: "evt_one",
    created,
    type: "session.text.ended",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: {
      sessionID,
      assistantMessageID: messageID,
      ordinal: 0,
      text,
    },
  };
}

function inbox(
  text: string,
  type: "user" | "synthetic" = "user",
): SessionInboxEnqueued {
  return {
    id: "evt_inbox",
    created: 100,
    type: "session.inbox.enqueued",
    durable: { aggregateID: "ses_one", seq: 1, version: 1 },
    data: {
      sessionID: "ses_one",
      inboxID: `msg_${type}`,
      item: { type, payload: { text }, delivery: "queue" },
    },
  };
}

function harness(history: ToastHistory = { seen: [] }) {
  const toasts: ToastOptions[] = [];
  const boundary: ToastBoundary = {
    startedAt: 100,
    history,
    update: (mutation) => mutation(history),
    show: (toast) => toasts.push(toast),
  };
  return { boundary, toasts };
}

test("recognizes plain, Markdown, angle and inline-code PR links", () => {
  for (const text of [
    url,
    `[PR #42](${url})`,
    `<${url}>`,
    `\`${url}\``,
    `${url}.`,
  ])
    assert.deepEqual(mentionedPRs(text), [url]);
});

test("normalizes case, trailing slash, query and fragment; deduplicates", () => {
  assert.deepEqual(
    mentionedPRs(
      `${url} https://GitHub.com/Owner/Repo/pull/42/?foo=bar#discussion_r1`,
    ),
    [url],
  );
});

test("ignores issues, unsafe URLs, lookalikes, unsupported PR paths and numbers", () => {
  const rejected = [
    "http://github.com/owner/repo/pull/42",
    "https://github.com.evil.test/owner/repo/pull/42",
    "https://github.com@evil.test/owner/repo/pull/42",
    "https://user:secret@github.com/owner/repo/pull/42",
    "https://github.com:8443/owner/repo/pull/42",
    "https://enterprise.test/owner/repo/pull/42",
    "https://github.com/owner/repo/issues/42",
    "https://github.com/owner/repo/pull/42/files",
    "https://github.com/owner/repo/pull/42suffix",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/01",
    "https://github.com/owner/repo/pull/9007199254740992",
  ];
  for (const text of rejected) assert.deepEqual(mentionedPRs(text), [], text);
});

test("shows a session-linked informational toast without claiming creation or activation", () => {
  const { boundary, toasts } = harness();
  notifyPRMentions(event(`Created [PR](${url}).`), boundary);
  assert.deepEqual(toasts, [
    {
      title: "Pull request mentioned",
      message: `${url}\nEnable monitoring: /pr-monitor on ${url}`,
      variant: "info",
      duration: 10_000,
      sessionID: "ses_one",
    },
  ]);
});

test("repeated blocks and replay notify once per message/PR, not once per session", () => {
  const { boundary, toasts } = harness();
  for (let i = 0; i < 5; i++)
    notifyPRMentions(event(`${url} ${url}#discussion_r1`), boundary);
  assert.equal(toasts.length, 1);
  notifyPRMentions(event(url, "ses_two"), boundary);
  assert.equal(toasts.length, 2);
  notifyPRMentions(
    event(`${url} https://github.com/owner/repo/pull/43`),
    boundary,
  );
  assert.equal(toasts.length, 3);
  notifyPRMentions(event(url, "ses_one", 100, "msg_two"), boundary);
  assert.equal(
    toasts.length,
    4,
    "A new message mentioning the same PR notifies again",
  );
});

test("memory history survives reload, without storing chat text", () => {
  const first = harness();
  notifyPRMentions(event(`${url} some private chat text`), first.boundary);
  const reloaded = harness(first.boundary.history);
  notifyPRMentions(event(url), reloaded.boundary);
  assert.equal(reloaded.toasts.length, 0);
  assert.deepEqual(first.boundary.history.seen, [
    JSON.stringify(["ses_one", "msg_one", url]),
  ]);
});

test("history replay predating setup is ignored", () => {
  const { boundary, toasts } = harness();
  notifyPRMentions(event(url, "ses_one", 99), boundary);
  assert.equal(toasts.length, 0);
  assert.equal(boundary.history.seen.length, 0);
});

test("history is bounded and evicts oldest entries", () => {
  const { boundary, toasts } = harness({
    seen: Array.from({ length: TOAST_HISTORY_LIMIT }, (_, i) => `old-${i}`),
  });
  notifyPRMentions(event(url), boundary);
  assert.equal(toasts.length, 1);
  assert.equal(boundary.history.seen.length, TOAST_HISTORY_LIMIT);
  assert.equal(boundary.history.seen[0], "old-1");
});

test("does not remember a notification if the toast API fails", () => {
  const { boundary } = harness();
  assert.throws(() =>
    notifyPRMentions(event(url), {
      ...boundary,
      show: () => {
        throw new Error("UI unavailable");
      },
    }),
  );
  assert.equal(boundary.history.seen.length, 0);
});

test("subscription cleanup stops future notifications", () => {
  const { boundary, toasts } = harness();
  let handler: ((event: MentionEvent) => void) | undefined;
  const cleanup = watchPRMentions((callback) => {
    handler = callback;
    return () => {
      handler = undefined;
    };
  }, boundary);
  handler?.(event(url));
  assert.equal(toasts.length, 1);
  cleanup();
  handler?.(event("https://github.com/owner/repo/pull/43"));
  assert.equal(toasts.length, 1);
});

test("TUI subscribes to completed assistant text and admitted chat messages, cleaning up both", () => {
  const subscriptions: string[] = [];
  let unsubscribed = 0;
  const cleanup = setupToasts({
    data: {
      on: (type) => {
        subscriptions.push(type);
        return () => {
          unsubscribed++;
        };
      },
    },
    storage: {
      memory: (_key, options) => [
        options.initial,
        (mutate) => mutate(options.initial),
      ],
    },
    ui: { toast: { show: () => {} } },
  });
  assert.deepEqual(subscriptions, [
    "session.text.ended",
    "session.inbox.enqueued",
  ]);
  cleanup();
  assert.equal(unsubscribed, 2);
});

test("a pasted user PR link and a synthetic status message each notify once", () => {
  const { boundary, toasts } = harness();
  const pasted = inbox(url);
  const status = inbox(`PR monitor: on\n${url}`, "synthetic");
  for (const e of [pasted, pasted, status, status])
    notifyPRMentions(e, boundary);
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0]?.sessionID, "ses_one");
});

test("inbox compaction and move controls do not trigger notifications", () => {
  const { boundary, toasts } = harness();
  const e = inbox(url);
  e.data.item = { type: "compaction", payload: {}, delivery: "queue" };
  notifyPRMentions(e, boundary);
  assert.equal(toasts.length, 0);
});
