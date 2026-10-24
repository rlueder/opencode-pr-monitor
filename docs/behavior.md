# Behavior and safety reference

See the [README](../README.md) for the quick start and toast capture.

An opt-in **OpenCode V2 plugin** that watches an open pull request and
queues repair requests in the session that enabled it. It detects terminal CI
failures, merge conflicts, and new eligible reviewer feedback. The existing
session investigates and fixes problems under its normal instructions and
permissions. The plugin itself only reads Git and GitHub.

Its companion terminal UI plugin shows a toast when a chat message mentions a
GitHub PR URL in chat, including after creating a PR. It offers the command to
enable monitoring without enabling it automatically.

## Local installation

Requires macOS or Linux, OpenCode V2 compatible with `@opencode/plugin` **2.1.4**, Node 22+
(development/tests), Git, and an authenticated `gh` executable available in the
**server's** PATH. Run `gh auth login` yourself if needed. Private repositories
need the corresponding GitHub read access. No credentials belong in this project
or the OpenCode configuration.

```sh
cd /path/to/opencode-pr-monitor
npm ci
npm run check
```

Manually merge this into the target project's `opencode.jsonc`, preserving its
existing plugins, permissions, and other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-pr-monitor"],
  "permissions": [
    {
      "action": "pr-monitor.enable",
      "resource": "https://github.com/OWNER/REPO/pull/*",
      "effect": "ask",
    },
  ],
}
```

Replace OWNER/REPO with the lowercase repository name. Configure `ask` rather
than broad automatic approval. Permission rules are ordered; check that existing
rules do not inadvertently override the intended decision. An existing deny is
not bypassed. Installation is local and unpublished; no global install is needed.
Use the project/worktree root as the OpenCode location, not a nested directory.
Config discovery/reload follows OpenCode V2; an unwatched external plugin source
edit may require a user-managed reload. This implementation does not restart it.

### PR mention toasts

The package exports a native `./tui` entrypoint, loaded alongside the server
plugin in compatible OpenCode V2 terminals. The root `tui.ts` also supports local
directory discovery. The terminal supplies OpenTUI and Solid; the package declares
them as optional peers so the server plugin remains usable on its own. Development
installs include their types for checking the custom JSX view. OpenTUI 0.6.8's Node
renderer requires Node 26.4+, or Bun 1.3.14+; ordinary controller tests do not load
the renderer. The lockfile overrides Seroval to 1.7.2 to avoid known vulnerabilities
in the serializer used by the renderer's pinned Solid peer.

When completed assistant text or an admitted user/status message contains a PR link, a nonmodal notification appears
at the bottom right of the terminal. It stays until dismissed, with clickable
**Turn on**, **Turn off**, **Refresh** and **Dismiss** controls. The on/off label
comes from actual server status, not an optimistic local toggle. While an action
or permission request is pending, the toggle is disabled. Errors appear inline.
**Turn on** uses the existing `/pr-monitor on <URL>` command and normal permission
prompt. **Turn off** uses `/pr-monitor off`, only if the session still monitors
that PR. Dismiss closes the notice without disabling monitoring or cancelling an
already submitted action. No auto-merge or extra write permissions are granted.
Buttons use the current OpenCode theme's hover, pressed and disabled colors.
There are no animations; pending controls stay visible but cannot be activated.

For keyboard access, run `/pr-monitor-notifications` or select **PR monitor
notifications** in the command palette. Choose a PR, then turn monitoring on/off
or dismiss it. Up to five notifications are retained; the newest is shown, and
dismissing it reveals an older one. Visible notification statuses refresh every
15 seconds through a read-only RPC, without GitHub or model calls.
To explicitly reopen a notification in the current session, run
`/pr-monitor-notifications https://github.com/OWNER/REPO/pull/42`. This only shows
the controls; it never enables monitoring.

Markdown links, inline code, query strings and fragment links are recognized.
Tool output, reasoning and inbox control items do not trigger it. A URL mention
alone does not establish that a PR was created, belongs to the session, or is
eligible for monitoring; the existing enable checks still enforce that boundary.

Notifications are deduplicated per canonical PR URL, message and session, including
plugin reloads. A new message mentioning the same PR reopens a dismissed notice
or brings the existing one to the front without resetting monitoring or interrupting
an in-flight action. Repeated text blocks or replay of the same message do not
notify again. Memory keeps up to 2,000 keys; older keys
can notify again after eviction. Events timestamped before plugin setup are
ignored instead of notifying about replayed history. Notifications require live
events with server and client clocks reasonably aligned. Existing chat history
is not scanned. Detection alone makes no GitHub calls, model prompts or permission
changes. Cleanup unsubscribes from chat events and aborts UI reads. An already
submitted command may still complete on the server after the UI unloads; use
`/pr-monitor status` and `off` if needed. This is a terminal feature,
not a desktop/web checkbox or OS notification.

## Commands

From the session that owns the checked-out PR branch:

```text
/pr-monitor on https://github.com/OWNER/REPO/pull/42
/pr-monitor status
/pr-monitor off
```

`on` validates the session location, worktree root, origin repository, local
branch and exact HEAD against the PR. It asserts `pr-monitor.enable` on the
canonical PR URL, using the session's normal permission rules. It baselines
existing comments, so enabling does not replay historical feedback. It never
automatically binds a PR created by a tool or inherited from another session.
Only one session may own an active binding at a location. Another session must
not silently take it over. Repeating `on` explicitly resets the baseline and
budgets, including for an already monitored PR.

Command execution itself is the explicit control surface. Like other OpenCode
commands, trusted API clients can invoke it too; it is not proof that a human
typed a keystroke. There is no model-callable enable tool or feedback-driven
enable path. Do not expose an unrestricted OpenCode API to untrusted clients.

**Opt-in does not approve commits or pushes.** A project requiring explicit
approval for those actions continues to require it. The repair session may stop
and ask. The plugin neither installs allow rules nor overrides permissions.
It never merges, rebases, force-pushes, auto-merges, or archives anything.

`status` inserts a synthetic status message with `resume: false`, without a model
call. `off` aborts ongoing reads promptly and persists the disabled binding.
An already admitted queued request cannot be retracted by this plugin; review
the session inbox before allowing it to run if necessary.

## Operation and safety

- One nonoverlapping sweep per minute while the server and location are loaded.
  One GraphQL snapshot per sweep; a second, small head/state read occurs only
  before delivery. No check logs are fetched. Read failures back off from two
  minutes to one hour and never wake the model by themselves.
- Queued `session.prompt` requests use `delivery: "queue", resume: true`: they
  wake idle sessions without steering active work. Durable plugin storage keeps
  a stable prompt ID before admission. Uncertain admissions retry that ID rather
  than generating a new one. Acknowledgement means durable admission, not that
  the repair ran or succeeded. Progress is recorded only after acknowledgement.
- Three reserved repair attempts per head, twelve per binding, with a five-minute
  cooldown between new reservations, extended on acknowledged delivery. Reservations also count stale/discarded
  outboxes, conservatively bounding uncertain admissions. A retry of the same
  outbox does not consume another reservation. A new PR head resets only the
  per-head budget. Use `status` to see budgets; explicit `on` resets them.
- Terminal failed checks and legacy failure/error statuses count; pending,
  successful, neutral, and skipped checks do not. Deduplication includes head,
  check ID and completion timestamp, allowing distinct reruns to be noticed.
- Unknown mergeability is not a conflict. Conflict events require a clean
  worktree and no merge/rebase/cherry-pick or other detected Git operation.
  Conflict keys include both head and base SHA. Repair instructions require
  merging the current base, never rebasing or force-pushing.
- New issue comments, submitted PR reviews and inline review replies are
  eligible only from OWNER/MEMBER/COLLABORATOR or a GitHub `Bot` actor. The current
  authenticated viewer's own feedback is excluded. Bot eligibility follows the
  API actor type; it is not a claim that every bot is trustworthy.
- Feedback is bounded quoted JSON, explicitly untrusted. Neither tags nor words
  in feedback establish provenance or authorization. The plugin never injects
  feedback into system instructions. Prompt-injection defenses are not a
  guarantee about model behavior; ordinary tool permissions remain essential.
- Before admission the plugin rechecks local state, session, and remote head.
  Queued events can still become stale afterwards: the session is instructed to
  recheck before acting. Closed/merged PRs and moved/archived/deleted sessions
  stop monitoring. Branch switches or foreign/stale heads pause with backoff
  until the exact checkout returns. No checkout/fetch/pull is performed.
- State contains PR identifiers, deduplication IDs, and any pending bounded
  feedback text in OpenCode's plugin storage. No auth material or check logs are
  stored or logged. Command diagnostics are drained without retention.
- Subprocesses use argv, no shell, a 20-second timeout, 4 MB stdout limit, and
  AbortSignals. Cancellation kills the owned POSIX process group, including
  helpers. Windows is rejected before spawning any subprocess because this MVP
  cannot guarantee helper-process tree cleanup there. Cleanup stops the timer, kills outstanding reads, and waits for
  work to finish. Reload uses native plugin lifecycle plus an in-module location
  guard. There is no distributed lock across independent OpenCode services.

## Limits and compatibility

- **GitHub.com only**, same-repository PRs, `origin` remote, attached local branch,
  and exact head match. Fork PRs, Enterprise, nested locations, and remote-name
  customization are intentionally unsupported rather than guessed.
- **Bounded API snapshot:** at most 100 check contexts, issue comments, reviews,
  review threads, and comments per thread. Each connection's `hasNextPage` is
  checked; any overflow or GraphQL partial error rejects the entire snapshot.
  This conservative MVP does not paginate. Large/old PRs may therefore be
  unsupported, including when many comments are irrelevant. Nothing is silently
  skipped. Fixing that limit needs paginated cursors or a different snapshot
  design, not increasing a magic number.
- Each request includes up to 30 failures and 20 comments, with 2,000 characters
  per body. Remaining events wait for another budgeted wakeup. Comment edits and
  review-thread resolution changes are not separate events. Failure transitions
  are observed by polling, so brief intermediate states may be missed.
- Native slash commands and explicit TUI actions control monitoring. Detection
  only notifies about chat-mentioned PR URLs. No desktop checkbox, separate review
  model, auto-merge, archive, live log streaming, or automatic PR binding.
- The host/service **must remain running and the location loaded**. Default
  OpenCode location idling may unload the plugin. If desired, the user can set
  `"experimental": { "location_idle_timeout": false }` in the relevant project
  config, after considering the resource cost. A timer is not a durable scheduler.
  After the location loads again, persisted bindings resume on the next tick.
- V2 2.1.4's `permission.assert` has **no cancellation argument**. Disable/unload
  stops awaiting it locally and a late approval cannot activate monitoring.
  The host-owned permission prompt may remain until dismissed; no unsupported
  cancellation or automatic permission reply is used.
- Metadata identifies the plugin's admission for auditing; it is not a signature.
  Multiple independent services pointed at the same location are unsupported.
  Restart/reload deduplication depends on OpenCode's documented durable admission
  semantics, not a claim of distributed exactly-once processing.

## Verification

`npm run check` checks formatting, typechecks all implementation and test files against the installed
**published** `@opencode/plugin@2.1.4` and runs isolated Node tests. The default
export also imports successfully under Node/tsx and is a V2 `Plugin.define`
object. No deprecated V1 plugin API is used. `npm audit --omit=dev` reports zero
known vulnerabilities in the installed dependency graph at implementation time.

Tests mock the OpenCode/GitHub boundary and clock, including restart/outbox
deduplication, eligibility, stale/dirty conflicts, budgets, backoff, isolation,
disable/unload, subprocess timeout/abort and literal argv. They never contact
GitHub or write a PR. Dogfooding has exercised real GitHub reads and server
activation/status/disable on this repository's PR. An end-to-end model repair
has not been verified. Both GraphQL queries validate against GitHub's public
GraphQL schema, downloaded without credentials by the optional
`npm run validate:github-schema` check. Adapter decoding is tested with synthetic
responses. Headless UI tests exercise the actual view, not a live desktop capture.

Notification tests cover URL recognition/rejection, normalization, session-linked
notifications, deduplication/reload, history replay, bounded memory, cleanup,
explicit on/off actions, permission errors, concurrent clicks, external state
changes and late async callbacks. The custom TUI view and RPC typecheck against
the published V2 API. Node tests exercise the controller, not terminal rendering.
`npm run test:ui` uses Bun 1.3.14+ and a headless OpenTUI renderer to verify
hover/leave styling, real on/off and dismiss mouse clicks, right-click rejection
and narrow-terminal layout. It also overlaps a focused textarea with the controls,
checks that the toast paints and receives clicks above it, verifies continued
typing and editor restoration after dismiss, and keeps blocking dialogs above
the toast. CI runs both suites with Node 26 and Bun 1.3.14.

The implementation follows the full V2 plugin, commands, plugin loading and
config guides, plus the V2 OpenAPI admission contract:

- <https://opencode.ai/v2/docs/build/plugins/>
- <https://opencode.ai/v2/docs/commands/>
- <https://opencode.ai/v2/docs/plugins/>
- <https://opencode.ai/v2/docs/config/>
- <https://opencode.ai/v2/docs/build/plugins/cli/>
- <https://opencode.ai/v2/openapi.json>

[`SPEC.md`](../SPEC.md) records the implementation contract. The npm package is
unpublished; the source repository is public. Installation and monitoring remain
explicit choices.
