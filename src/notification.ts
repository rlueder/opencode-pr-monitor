import type { MonitorStatus } from "./rpc.ts";

export interface Notification {
  key: string;
  sessionID: string;
  url: string;
  directory: string;
  status: MonitorStatus | null;
  busy: boolean;
  error: string | null;
}

export interface NotificationPorts {
  status: (notice: Notification, signal: AbortSignal) => Promise<MonitorStatus>;
  command: (
    notice: Notification,
    text: string,
    signal: AbortSignal,
  ) => Promise<void>;
  changed: (notices: Notification[]) => void;
}

export class Notifications {
  private notices: Notification[] = [];
  private controller = new AbortController();
  constructor(private readonly ports: NotificationPorts) {}

  add(sessionID: string, url: string, directory: string) {
    if (this.controller.signal.aborted) return;
    const key = JSON.stringify([sessionID, url]);
    const existing = this.notices.find((notice) => notice.key === key);
    if (existing) {
      // A new chat message may mention an already visible PR. Promote the same
      // notice without discarding a permission request or in-flight action.
      this.notices = this.notices.filter((notice) => notice !== existing);
      this.notices.push(existing);
      this.emit();
      void this.refresh(key);
      return;
    }
    // Never evict a notification whose explicit action is still running.
    if (this.notices.length >= 5) {
      const removable = this.notices.findIndex((notice) => !notice.busy);
      if (removable === -1) return;
      this.notices.splice(removable, 1);
    }
    const notice: Notification = {
      key,
      sessionID,
      url,
      directory,
      status: null,
      busy: false,
      error: null,
    };
    this.notices.push(notice);
    this.emit();
    void this.refresh(key);
  }

  dismiss(key: string) {
    this.notices = this.notices.filter((notice) => notice.key !== key);
    this.emit();
  }

  private emit() {
    if (!this.controller.signal.aborted)
      this.ports.changed(this.notices.map((notice) => ({ ...notice })));
  }

  refreshAll() {
    return Promise.all(this.notices.map((notice) => this.refresh(notice.key)));
  }

  refresh(key: string) {
    return this.run(key);
  }

  act(key: string, enabled: boolean) {
    return this.run(key, enabled);
  }

  private async run(key: string, enabled?: boolean) {
    const notice = this.notices.find((item) => item.key === key);
    if (!notice || notice.busy || this.controller.signal.aborted) return;
    notice.busy = true;
    notice.error = null;
    this.emit();
    try {
      const signal = this.controller.signal;
      notice.status = await this.ports.status(notice, signal);
      if (signal.aborted) return;
      if (enabled !== undefined) {
        if (!enabled && notice.status.url !== notice.url)
          throw new Error("Monitoring changed. Refresh before turning it off.");
        await this.ports.command(
          notice,
          enabled ? `on ${notice.url}` : "off",
          signal,
        );
        if (signal.aborted) return;
        notice.status = await this.ports.status(notice, signal);
        if (
          notice.status.enabled !== enabled ||
          (enabled && notice.status.url !== notice.url)
        )
          throw new Error(
            "Monitoring changed before confirmation. Refresh its status.",
          );
      }
    } catch (error) {
      // SDK errors may contain structured diagnostics; do not render raw JSON.
      notice.error =
        error instanceof Error
          ? error.message.slice(0, 300)
          : "PR monitor request failed. Try Refresh.";
    } finally {
      notice.busy = false;
      this.emit();
    }
  }

  close() {
    this.controller.abort();
    this.notices = [];
  }
}
