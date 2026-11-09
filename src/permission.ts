import type { Plugin } from "@opencode/plugin";

export const ENABLE_ACTION = "pr-monitor.enable";

// The only permission this plugin ever asserts. Its Git and GitHub reads run as
// plain subprocesses, never through a session tool, so they cannot prompt. With
// an `allow` rule for this action, enabling completes without a prompt; `ask`
// and `deny` rules are still honoured because the host evaluates them here.
export function assertEnable(
  permission: Pick<Plugin.Context["permission"], "assert">,
  sessionID: string,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  // assert has no cancellation API in 2.1.4. Stop awaiting locally on unload;
  // the host-owned permission request may still need user dismissal.
  return new Promise<void>((accept, reject) => {
    const abort = () => reject(new Error("Enable cancelled"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void permission
      .assert({
        sessionID,
        action: ENABLE_ACTION,
        resources: [url],
        save: [url],
        metadata: {
          description:
            "Read this PR in the background and queue bounded repair requests in this session. This does not approve commits or pushes.",
        },
      })
      .then(accept, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
