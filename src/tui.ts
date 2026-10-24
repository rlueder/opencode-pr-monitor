import { Plugin } from "@opencode/plugin/tui";
import { watchPRMentions } from "./pr-toast.ts";

type ToastContext = {
  data: Pick<Plugin.Context["data"], "on">;
  storage: Pick<Plugin.Context["storage"], "memory">;
  ui: Pick<Plugin.Context["ui"], "toast">;
};

export function setupToasts(context: ToastContext): () => void {
  const startedAt = Date.now();
  const [history, update] = context.storage.memory("pr-mentions/v1", {
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

export default Plugin.define({
  id: "opencode.pr-monitor.tui",
  setup: setupToasts,
});
