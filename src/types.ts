export type PR = { url: string; repo: string; number: number };
export type Local = {
  root: string;
  repo: string;
  branch: string;
  head: string;
  dirty: boolean;
  operation: boolean;
};
export type Comment = {
  id: string;
  author: string;
  association: string;
  bot: boolean;
  body: string;
  url: string;
};
export type Snapshot = {
  state: string;
  head: string;
  base: string;
  branch: string;
  headRepo: string;
  mergeable: boolean | null;
  failures: { key: string; name: string; url: string }[];
  comments: Comment[];
  viewer: string;
};
export type Outbox = {
  id: string;
  head: string;
  text: string;
  keys: string[];
  comments: string[];
};
export type Binding = {
  version: 1;
  session: string;
  directory: string;
  pr: PR;
  branch: string;
  enabled: boolean;
  reason: string;
  head: string;
  seen: string[];
  delivered: string[];
  wakes: number;
  total: number;
  last: number;
  next: number;
  errors: number;
  attempts: number;
  totalAttempts: number;
  pending: Outbox | null;
};
export interface Ports {
  directory: string;
  now(): number;
  id(): string;
  load(): Promise<Binding | undefined>;
  save(binding: Binding): Promise<void>;
  session(
    id: string,
    signal: AbortSignal,
  ): Promise<{ directory: string; archived: boolean }>;
  permission(session: string, url: string, signal: AbortSignal): Promise<void>;
  local(signal: AbortSignal): Promise<Local>;
  snapshot(pr: PR, signal: AbortSignal): Promise<Snapshot>;
  head(pr: PR, signal: AbortSignal): Promise<{ head: string; state: string }>;
  deliver(session: string, box: Outbox, signal: AbortSignal): Promise<void>;
}

export function parsePR(value: string): PR {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      value,
    );
  if (
    !match ||
    !match[1] ||
    !match[2] ||
    !match[3] ||
    !Number.isSafeInteger(Number(match[3]))
  )
    throw new Error(
      "Use an exact https://github.com/OWNER/REPO/pull/NUMBER URL.",
    );
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return {
    repo,
    number: Number(match[3]),
    url: `https://github.com/${repo}/pull/${Number(match[3])}`,
  };
}

// Storage is not a trusted type boundary, including after an upgrade.
export function decodeBinding(value: unknown): Binding | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object")
    throw new Error("Invalid monitor storage");
  const b = value as Record<string, unknown>;
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((v) => typeof v === "string");
  const object = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  if (
    b.version !== 1 ||
    !["session", "directory", "branch", "reason", "head"].every(
      (k) => typeof b[k] === "string",
    ) ||
    typeof b.enabled !== "boolean" ||
    !strings(b.seen) ||
    !strings(b.delivered) ||
    ![
      "wakes",
      "total",
      "last",
      "next",
      "errors",
      "attempts",
      "totalAttempts",
    ].every(
      (k) =>
        typeof b[k] === "number" && Number.isFinite(b[k]) && Number(b[k]) >= 0,
    ) ||
    !object(b.pr) ||
    typeof b.pr.url !== "string" ||
    b.pr.repo !== parsePR(b.pr.url).repo ||
    b.pr.number !== parsePR(b.pr.url).number ||
    !(
      b.pending === null ||
      (object(b.pending) &&
        ["id", "head", "text"].every(
          (k) =>
            typeof b.pending === "object" &&
            b.pending !== null &&
            typeof Reflect.get(b.pending, k) === "string",
        ) &&
        strings(b.pending.keys) &&
        strings(b.pending.comments))
    )
  )
    throw new Error("Invalid monitor storage");
  // Every field above is validated; this cast decodes persisted JSON, not a V2 API.
  return value as Binding;
}
