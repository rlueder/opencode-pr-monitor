import { createSignal, Show } from "solid-js";
import type { ResolvedTheme } from "@opencode/theme/tui";
import type { Notification } from "./notification.ts";

// Above composer content (1000), below blocking dialogs (3000).
export const NOTIFICATION_LAYER = 2000;

type ButtonColors = {
  text: { action: Pick<ResolvedTheme["text"]["action"], "secondary"> };
  background: {
    action: Pick<ResolvedTheme["background"]["action"], "secondary">;
  };
};

function Button(props: {
  theme: ButtonColors;
  label: string;
  disabled?: boolean;
  press: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  const [pressed, setPressed] = createSignal(false);
  const state = () => ({
    disabled: !!props.disabled,
    hovered: hovered(),
    pressed: pressed(),
  });
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.theme.background.action.secondary.state(state())}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        if (!props.disabled) setPressed(true);
      }}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const activate = pressed() && !props.disabled;
        setPressed(false);
        if (activate) props.press();
      }}
    >
      <text fg={props.theme.text.action.secondary.state(state())}>
        {props.label}
      </text>
    </box>
  );
}

export function NotificationView(props: {
  theme: ButtonColors & {
    text: Pick<ResolvedTheme["text"], "base" | "muted">;
    border: ResolvedTheme["border"];
    background: { raised: Pick<ResolvedTheme["background"]["raised"], "base"> };
  };
  notices: Notification[];
  act: (key: string, enabled: boolean) => Promise<void>;
  refresh: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
}) {
  return (
    <Show when={props.notices.at(-1)}>
      {(current) => (
        <box
          position="absolute"
          bottom={1}
          right={1}
          width="90%"
          maxWidth={80}
          zIndex={NOTIFICATION_LAYER}
          border
          borderColor={props.theme.border.base}
          backgroundColor={props.theme.background.raised.base}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg={props.theme.text.base}>
            Pull request mentioned ({props.notices.length})
          </text>
          <text fg={props.theme.text.base} wrapMode="word">
            {current().url}
          </text>
          <text fg={props.theme.text.muted}>
            {current().busy
              ? "Working… check permission prompts if needed."
              : current().status === null
                ? "Status unavailable. Refresh to retry."
                : current().status?.enabled &&
                    current().status?.url === current().url
                  ? "Monitoring is on"
                  : current().status?.enabled
                    ? "This session is monitoring another PR"
                    : "Monitoring is off"}
          </text>
          <Show when={current().error}>
            <text fg={props.theme.text.base} wrapMode="word">
              {current().error}
            </text>
          </Show>
          <box flexDirection="row" flexWrap="wrap" gap={2}>
            <Button
              theme={props.theme}
              disabled={current().busy || current().status === null}
              label={
                current().status?.enabled &&
                current().status?.url === current().url
                  ? "[Turn off]"
                  : "[Turn on]"
              }
              press={() => {
                void props.act(
                  current().key,
                  !(
                    current().status?.enabled &&
                    current().status?.url === current().url
                  ),
                );
              }}
            />
            <Button
              theme={props.theme}
              label="[Refresh]"
              disabled={current().busy}
              press={() => {
                void props.refresh(current().key);
              }}
            />
            <Button
              theme={props.theme}
              label="[Dismiss]"
              press={() => props.dismiss(current().key)}
            />
          </box>
          <text fg={props.theme.text.muted}>
            Keyboard: /pr-monitor-notifications
          </text>
        </box>
      )}
    </Show>
  );
}
