import type { Plugin } from "@opencode/plugin";
import { parsePR } from "./types.ts";

// Deliberately not a shell parser: unsupported syntax keeps manual controls.
export function directCreate(tool: string, input: unknown, directory: string) {
  if (!["shell", "bash", "functions.shell", "functions_shell"].includes(tool))
    return false;
  if (
    !input ||
    typeof input !== "object" ||
    !("command" in input) ||
    typeof input.command !== "string"
  )
    return false;
  if ("workdir" in input && input.workdir !== directory) return false;
  if ("cwd" in input && input.cwd !== directory) return false;
  const words: string[] = [];
  let word = "",
    quote = "",
    escaped = false,
    present = false;
  for (const char of input.command.trim()) {
    if (escaped) {
      word += char;
      escaped = false;
      present = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && /[$`]/.test(char)) return false;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      present = true;
      continue;
    }
    if (/[\n\r;&|<>$`(){}*?\[\]~#]/.test(char)) return false;
    if (/\s/.test(char)) {
      if (present) words.push(word);
      word = "";
      present = false;
    } else {
      word += char;
      present = true;
    }
  }
  if (quote || escaped) return false;
  if (present) words.push(word);
  return words[0] === "gh" && words[1] === "pr" && words[2] === "create";
}

export function createdURL(text: string): string | undefined {
  const urls = text
    .split(/\r?\n/)
    .map((line) => {
      try {
        return parsePR(line.trim()).url;
      } catch {
        return undefined;
      }
    })
    .filter((url) => url !== undefined);
  return urls.length === 1 ? urls[0] : undefined;
}

type Created = (
  session: string,
  url: string,
  started: number,
  ended: number,
) => Promise<void>;

export class CreationCalls {
  private calls = new Map<string, number>();
  private closed = false;
  constructor(
    private readonly directory: string,
    private readonly created: Created,
    private readonly now = Date.now,
  ) {}
  before(session: string, id: string, tool: string, input: unknown) {
    if (!this.closed && directCreate(tool, input, this.directory)) {
      if (this.calls.size >= 1000)
        this.calls.delete(this.calls.keys().next().value!);
      this.calls.set(`${session}/${id}`, this.now());
    }
  }
  after(
    session: string,
    id: string,
    tool: string,
    input: unknown,
    text?: string,
  ) {
    const key = `${session}/${id}`;
    const started = this.calls.get(key);
    this.calls.delete(key);
    if (
      this.closed ||
      started === undefined ||
      text === undefined ||
      !directCreate(tool, input, this.directory)
    )
      return;
    const url = createdURL(text);
    // Permission approval must not hold the originating tool's after hook open.
    if (url)
      void this.created(session, url, started, this.now()).catch(() => {});
  }
  close() {
    this.closed = true;
    this.calls.clear();
  }
}

export async function watchCreations(
  tool: Pick<Plugin.Context["tool"], "hook">,
  directory: string,
  created: Created,
  now = Date.now,
) {
  const calls = new CreationCalls(directory, created, now);
  const before = await tool.hook("execute.before", (event) => {
    calls.before(event.sessionID, event.id, event.tool, event.input);
  });
  const after = await tool.hook("execute.after", (event) => {
    const content =
      event.status === "completed" ? event.result.content : undefined;
    const text =
      typeof content === "string"
        ? content
        : (content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") ?? "");
    calls.after(
      event.sessionID,
      event.id,
      event.tool,
      event.input,
      event.status === "completed" ? text : undefined,
    );
  });
  return async () => {
    calls.close();
    await before.dispose();
    await after.dispose();
  };
}
