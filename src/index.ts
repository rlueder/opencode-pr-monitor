import { realpath } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import { Monitor, POLL } from "./engine.ts";
import { GitHub, readLocal, runner } from "./github.ts";
import { decodeBinding } from "./types.ts";

// The V2 runtime owns one active plugin/location. This extra guard also protects
// accidental duplicate setup in the same module instance during reload.
const owners = new Map<string, () => Promise<void>>();

export default Plugin.define({
  id: "opencode.pr-monitor",
  async setup(ctx) {
    const directory = await realpath(ctx.location.directory);
    await owners.get(directory)?.();
    const run = runner(directory);
    const github = new GitHub(run);
    const key = `binding/v1/${encodeURIComponent(directory)}`;
    const monitor = new Monitor({
      directory,
      now: Date.now,
      id: () => `msg_prmonitor_${crypto.randomUUID().replaceAll("-", "")}`,
      load: async () => decodeBinding(await ctx.storage.get(key)),
      save: async (b) => {
        await ctx.storage.set(key, b);
      },
      session: async (id, signal) => {
        const s = await ctx.session.get({ sessionID: id }, { signal });
        if (
          s.projectID !== ctx.location.project.id ||
          (s.subpath && s.subpath !== ".")
        )
          throw new Error("Session moved or uses a nested subpath");
        return {
          directory: await realpath(s.location.directory),
          archived: s.time.archived !== undefined,
        };
      },
      permission: async (sessionID, url, signal) => {
        // assert has no cancellation API in 2.1.4. Stop awaiting locally on unload;
        // the host-owned permission request may still need user dismissal.
        await new Promise<void>((accept, reject) => {
          const abort = () => reject(new Error("Enable cancelled"));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          void ctx.permission
            .assert({
              sessionID,
              action: "pr-monitor.enable",
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
      },
      local: (signal) => readLocal(directory, run, signal),
      snapshot: (pr, signal) => github.snapshot(pr, signal),
      head: (pr, signal) => github.head(pr, signal),
      deliver: async (sessionID, box, signal) => {
        await ctx.session.prompt(
          {
            sessionID,
            id: box.id,
            text: box.text,
            delivery: "queue",
            resume: true,
            metadata: { source: "opencode.pr-monitor", head: box.head },
          },
          { signal },
        );
      },
    });
    await monitor.init();
    const registration = await ctx.command.transform((editor) => {
      editor.add({
        name: "pr-monitor",
        description:
          "Explicitly enable, disable, or inspect session-bound PR monitoring",
        execute: async ({ sessionID, prompt }) => {
          const text = await monitor.command(sessionID, prompt.text);
          await ctx.session.synthetic({
            sessionID,
            text,
            description: "PR monitor status",
            delivery: "queue",
            resume: false,
            metadata: { source: "opencode.pr-monitor.status" },
          });
        },
      });
    });
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    // Rearm after completion, so slow reads cannot overlap or cause the next
    // fixed-interval tick to miss a newly computed poll deadline.
    const schedule = () => {
      timer = setTimeout(() => {
        void monitor
          .sweep()
          .catch(() => {})
          .finally(() => {
            if (!closed) schedule();
          });
      }, POLL);
      timer.unref();
    };
    schedule();
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      await monitor.close();
      await registration.dispose();
      if (owners.get(directory) === cleanup) owners.delete(directory);
    };
    owners.set(directory, cleanup);
    return cleanup;
  },
});
