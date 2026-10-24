import { Plugin } from "@opencode/plugin/tui";
import { createComponent, createSignal } from "solid-js";
import { setupToasts } from "./pr-toast.ts";
import { Notifications, type Notification } from "./notification.ts";
import { NotificationView } from "./notification-view.tsx";
import { decodeStatus, MonitorUI } from "./rpc.ts";
import { parsePR } from "./types.ts";

export default Plugin.define({
  id: "opencode.pr-monitor.tui",
  setup(context) {
    const [notices, setNotices] = createSignal<Notification[]>([]);
    const rpc = context.client.rpc(MonitorUI);
    const notifications = new Notifications({
      changed: (value) => setNotices(value),
      status: async (notice, signal) => {
        const session = await context.client.session.get(
          { sessionID: notice.sessionID },
          { signal },
        );
        if (
          session.location.directory !== notice.directory ||
          session.time.archived !== undefined
        )
          throw new Error(
            "Session moved or was archived. Monitoring controls are unavailable.",
          );
        return decodeStatus(
          await rpc.status(
            { sessionID: notice.sessionID },
            {
              location: { directory: notice.directory },
              signal,
            },
          ),
        );
      },
      command: async (notice, text, signal) => {
        await context.client.session.command(
          { sessionID: notice.sessionID, name: "pr-monitor", text },
          { signal },
        );
      },
    });
    const stopMessages = setupToasts({
      data: context.data,
      storage: context.storage,
      ui: {
        toast: {
          show: (toast) => {
            const sessionID = toast.sessionID;
            const url = toast.message.split("\n")[0];
            if (!sessionID || !url) return;
            void context.client.session
              .get({ sessionID })
              .then((session) => {
                notifications.add(sessionID, url, session.location.directory);
              })
              .catch(() => {});
          },
        },
      },
    });
    const stopView = context.ui.slot({
      append: "app",
      render: () =>
        createComponent(NotificationView, {
          theme: context.theme,
          get notices() {
            return notices();
          },
          act: (key, enabled) => notifications.act(key, enabled),
          refresh: (key) => notifications.refresh(key),
          dismiss: (key) => notifications.dismiss(key),
        }),
    });
    context.keymap.layer(() => ({
      commands: [
        {
          id: "pr-monitor.notifications",
          title: "PR monitor notifications",
          group: "PR monitor",
          palette: true,
          slash: { name: "pr-monitor-notifications", arguments: true },
          run: async (input) => {
            if (input?.trim()) {
              try {
                const url = parsePR(input.trim()).url;
                const route = context.ui.router.current();
                if (route.type !== "session")
                  throw new Error("Open a session first.");
                const session = await context.client.session.get({
                  sessionID: route.sessionID,
                });
                notifications.add(
                  route.sessionID,
                  url,
                  session.location.directory,
                );
              } catch (error) {
                context.ui.toast.show({
                  title: "PR monitor",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Could not show notification",
                  variant: "error",
                });
              }
              return;
            }
            const selected = await context.ui.dialog.select({
              title: "PR monitor notifications",
              options: notices().map((notice) => ({
                title: notice.url,
                value: notice.key,
              })),
            });
            const notice = notices().find((item) => item.key === selected);
            if (!notice) return;
            await notifications.refresh(notice.key);
            const current = notices().find((item) => item.key === notice.key);
            if (!current || current.busy || !current.status) return;
            const enabled =
              current.status.enabled && current.status.url === current.url;
            const action = await context.ui.dialog.select({
              title: current.url,
              options: [
                {
                  title: enabled ? "Turn off monitoring" : "Turn on monitoring",
                  value: "toggle",
                },
                { title: "Dismiss", value: "dismiss" },
              ],
            });
            if (action === "toggle")
              await notifications.act(current.key, !enabled);
            if (action === "dismiss") notifications.dismiss(current.key);
          },
        },
      ],
    }));
    const timer = setInterval(() => {
      void notifications.refreshAll();
    }, 15_000);
    return () => {
      clearInterval(timer);
      stopMessages();
      stopView();
      notifications.close();
    };
  },
});
