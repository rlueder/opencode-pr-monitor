# Implementation specification

Standalone, original OpenCode V2 server plugin. No changes to other repositories,
user configuration, shared services, or live GitHub resources.

## Control and authorization

Register `/pr-monitor on https://github.com/OWNER/REPO/pull/NUMBER`, `off`, and
`status` through `ctx.command.transform`. No enable tool, inherited
binding, or inference from comments. Before enable, assert the stable action
`pr-monitor.enable` against the canonical PR URL, using ordinary session rules.
Command invocation is explicit intent, not an authentication boundary: API clients
can invoke commands too. Never change permissions. Monitor opt-in is not approval
to commit, push, merge, or ignore project instructions.

## Binding and reads

One session owns one binding per exact canonical location. Validate session
directory, Git worktree root, origin repository, local branch, local HEAD, PR
head repository and SHA. Reject forks for this MVP rather than guess remote
ownership. Use authenticated `gh` via argv, never a shell. Only read operations.
GitHub.com only. Fail closed on partial/oversized API results. Read comments
with explicit connection overflow detection, catch up existing eligible feedback at enable, then deliver eligible new
review/issue comments and reviews. Eligible: OWNER/MEMBER/COLLABORATOR or Bot;
exclude authenticated user. Read check runs and legacy commit statuses for the
exact head. Only terminal failures count. Unknown mergeability is not conflict.

## Engine and durable state

`ctx.storage` holds versioned bindings including baseline comments, delivered
event keys, wakeup counts, cooldown, errors/backoff, and pending delivery ID/text.
Sweeps run sequentially every 60 seconds, never overlap. Per-head CI keys include
check/run identity and completion time; conflict keys include head and base SHA.
Three reserved wakeups per head and twelve per binding, five-minute cooldown.
Reserve the budget when persisting an outbox, so uncertain admission or discarded
stale work cannot bypass the budget. Keep acknowledged admissions separately.
New heads reset per-head budget but not total budget. Re-enable is explicit reset.
Persist an outbox with a stable OpenCode message ID before prompt admission;
retry that ID after uncertain failures/restarts and record progress after durable
admission, not model completion. Inspect exact V2 types/implementation for support.
If exact retry safety is unavailable, document the limitation rather than fake it.

## Delivery and safety

Queued durable prompts wake idle sessions and do not steer active ones. Revalidate
session/local state and remote head before admission. Skip stale head/branch;
stop closed/merged/invalid sessions. Conflict delivery requires clean tree and no
ongoing Git operation. Messages identify plugin observations, quote bounded JSON
feedback as untrusted, and require rechecking current state before action. XML
tags are not proof of origin. No raw feedback in system messages or log fetching.
Only originating session receives prompts. Disable aborts outstanding reads and
prevents future admission; already admitted prompts cannot be retracted via the
documented public API. Unload aborts reads, clears timer, awaits in-flight work.
In-process location ownership prevents duplicate instances, in addition to the
native runtime lifecycle. Storage keys include the canonical location. No claim
of cross-service distributed exactly-once locking. Permission assertions cannot
be cancelled through V2 2.1.4; stop awaiting locally and prevent late activation.

## Verification and scope

Use installed V2 types without `any` or compatibility casts. Deterministic unit
tests mock only adapter boundaries and clock. Test controls, isolation, state
recovery, outbox admission, transitions, stale/dirty conflicts, comments, budgets,
backoff, cancellation and concurrent sweeps. Test subprocess adapter with local
read-only commands, never live PR writes. README includes actual compatibility,
manual configuration, permission examples, runtime requirements and limitations.
No auto-merge or archive.

## PR mention toast

Expose a separate native V2 `./tui` entrypoint. Listen to `session.text.ended`
for completed assistant-visible text and `session.inbox.enqueued` for admitted
user and synthetic chat messages. Ignore reasoning, tool output and inbox controls.
Recognize exact GitHub.com PR links in plain text and Markdown, normalize case,
ignore URL query/fragment suffixes, and show a session-linked notification.
A mention is not evidence of PR creation or
ownership; label it as a mention, not as a newly created PR or enabled monitor.
Never run a command, call GitHub, or change permissions from detection.

Notify once per canonical PR URL per message per session, with a bounded
2,000-key memory store surviving plugin reload. Ignore events predating setup
so history replay does not generate notifications. Different sessions may each
notify for the same PR. Unsubscribe on cleanup. Use documented TUI slots rather
than unsupported native toast action fields or desktop UI hooks. Backend remains usable without TUI.
Test detection, normalization, duplicates, session isolation, history replay,
ignored content types, reload and cleanup against published V2 types.

## Actionable notification

Replace the text-only native toast with a custom, nonmodal TUI `app` slot.
Show session-associated PR notifications with clickable Turn on/Turn off,
Refresh and Dismiss controls and keyboard access through a palette command.
Do not expire a notification while the user is considering activation or a
permission prompt. Read actual monitoring state using a read-only location-scoped
RPC, then invoke the existing server command on explicit UI action. Never add an
RPC that bypasses permission checks or enables monitoring on URL detection.
Verify the session location, prevent duplicate actions, report errors inline,
re-read state after commands and do not disable a different PR implicitly.
Use native theme tokens for hovered, pressed and disabled button colors. Disabled
controls remain visible and ignore clicks; pointer departure resets button state.
Bound the visible list, clean up listeners and ignore late async UI updates after
unload. Notifications describe mentions, not confirmed PR creation. Keep monitor
state on the server and preserve working slash commands. Document OpenTUI peers,
verification limitations, and test the action controller separately from rendering.

Repeat mentions in a new message must reopen a dismissed notice or bring its
existing notification to the front and refresh it. Streaming text blocks and
replayed events for the same message/URL must not duplicate it. Multiple mentions
in one message share one notification. Repeated mentions must not reset monitoring,
consume repair attempts, or interrupt an in-flight UI action.

## README and capture

Make README a concise public quick start with relative screenshot links, generic
installation paths, clickable controls, keyboard commands, permissions and key
limitations. Preserve detailed operational contracts in docs/behavior.md.
Capture the real NotificationView in an isolated OpenTUI renderer with a sample
dark theme and public PR URL, including a hovered toggle. Export the captured
cells and colors to SVG/PNG with a reproducible development script. Label this
as a headless component capture with sample state, not a live desktop screenshot
or proof of monitoring. Do not capture unrelated desktop/chat data or change
monitoring state. Inspect the image before referencing it in README.

## Composer overlap regression

Reproduce the screenshot with an actual focused textarea overlapping the toast's
action row. Cover foreground text, opaque backgrounds and mouse hit-testing,
not merely an isolated toast. Give notifications a layer above composer content
and below blocking dialogs. Confirm typing still reaches the focused editor,
toast clicks do not fall through, and hiding the toast reveals the intact editor.
Keep native permission dialogs above the notification. Do not patch OpenCode
or classify this as an upstream defect unless a minimal renderer test supports it.

## Ghost-text coexistence

The installed ghost-text v0.1.0 plugin fills its suggestion row in a global
postprocessor, which overwrites all composed layers. A z-index-only textarea
test cannot detect this. Add an optional integration test that compiles the
actual ghost module supplied by the developer against the same OpenTUI runtime as
NotificationView, mirroring OpenCode's shared plugin runtime. It must fail with
the old painter and pass with the native scene-preview fix in the ghost plugin.
Check first-frame composition, hidden-suggestion acceptance, dismissal and
restored suggestions. Do not copy the ghost algorithm into a mock or disable
the other plugin as a purported fix. Rejected activation of a closed/merged PR
must report that terminal state before comparing checkout SHAs.

## Immediate creation activation

Use live `tool.execute.before/after` hooks, never history or chat mentions. Recognize
only a direct, single `gh pr create` shell invocation with literal arguments and
no shell expansions or control operators. Require a completed result containing
exactly one standalone PR URL, verify GitHub author equals authenticated viewer,
and verify creation time is within the live call window. Keep all exact session,
repository, branch and head checks. Unsupported wrappers, pipelines, MCP creation
and external creation retain manual controls rather than infer ownership.

Start the ordinary `pr-monitor.enable` permission assertion immediately after
verification, independently of TUI clicks and session inbox delivery. Do not block
tool completion awaiting user permission. Revalidate after permission, persist the
binding, then sweep immediately. Catch up eligible existing feedback, excluding
resolved/outdated review threads and dismissed reviews. Never baseline unresolved
feedback during activation. Preserve queue delivery, untrusted quoting, budgets
and durable deduplication; repeated creation observations must not reset bindings.

Persist explicit `off` by session/location even before a binding exists. Automatic
activation cannot override it or another session's binding. Only explicit `on`
clears that session's opt-out. Off/unload cancels pending local activation, including
late approvals. Unit-test creation recognition, hook wiring, permission delay/race,
opt-out persistence, catch-up and ownership checks without live monitor mutations.

When a timer fires before a binding's next deadline, rearm for the remaining
delay rather than a full polling interval. Resume an overdue persisted binding
without an extra minute of startup delay. Keep sweeps nonoverlapping.
