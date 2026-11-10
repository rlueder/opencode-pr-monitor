import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Comment, Local, PR, Snapshot, Target } from "./types.ts";

export type Runner = (
  file: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>;
export function runner(
  cwd: string,
  timeout = 20_000,
  maxBytes = 4_000_000,
): Runner {
  if (process.platform === "win32")
    throw new Error(
      "PR monitor requires POSIX process-group cancellation (macOS/Linux).",
    );
  return (file, args, signal) =>
    new Promise((accept, reject) => {
      if (signal.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      const child = spawn(file, args, {
        cwd,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const stop = () => {
        failed = true;
        // Own a process group so a credential helper or Git child cannot outlive
        // cancellation. Windows is rejected before spawning any subprocess.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, timeout);
      signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) stop();
        if (!failed) chunks.push(chunk);
      });
      // Drain stderr, but never retain or log auth-sensitive command diagnostics.
      child.stderr.resume();
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (failed || code !== 0 || signal.aborted)
          reject(
            new Error(
              "Read command failed, timed out, aborted, or exceeded output limit",
            ),
          );
        else accept(Buffer.concat(chunks).toString("utf8"));
      });
    });
}

export function remoteRepo(url: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match?.[1])
    throw new Error(
      "Origin must be a GitHub.com repository URL without credentials",
    );
  return match[1].toLowerCase();
}

export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
};

// Parses `git worktree list --porcelain -z`: NUL-terminated attribute lines,
// with an empty field ending each worktree record.
export function parseWorktrees(raw: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const field of raw.split("\0")) {
    if (!field) {
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const name = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (name === "worktree") {
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        prunable: false,
      };
      trees.push(current);
    } else if (!current) throw new Error("Malformed worktree list");
    else if (name === "HEAD") current.head = value;
    else if (name === "branch") current.branch = value;
    else if (name === "bare") current.bare = true;
    else if (name === "prunable") current.prunable = true;
  }
  return trees;
}

async function existing(path: string) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

// Reads the session's repository and finds the worktree that has the PR checked
// out. The session directory itself may be any worktree of that repository.
export async function readLocal(
  directory: string,
  target: Target,
  run: Runner,
  signal: AbortSignal,
): Promise<Local> {
  const git = (...args: string[]) => run("git", args, signal);
  const [origin, list] = await Promise.all([
    git("remote", "get-url", "origin"),
    git("worktree", "list", "--porcelain", "-z"),
  ]);
  const repo = remoteRepo(origin);
  const trees = parseWorktrees(list).filter(
    (tree) => !tree.bare && !tree.prunable && !!tree.head,
  );
  let chosen = target.branch
    ? trees.find((tree) => tree.branch === `refs/heads/${target.branch}`)
    : undefined;
  let root = chosen ? await existing(chosen.path) : undefined;
  if (!chosen) {
    // A detached checkout of the exact PR head also counts. Prefer the
    // session's own directory when several qualify.
    for (const tree of trees.filter(
      (t) => t.branch === null && t.head === target.head,
    )) {
      const path = await existing(tree.path);
      if (path && (!root || path === directory)) {
        root = path;
        chosen = tree;
      }
    }
  }
  if (!chosen?.head || !root) return { repo, checkout: null };
  const [status, gitdir] = await Promise.all([
    git("-C", root, "status", "--porcelain", "--untracked-files=normal"),
    git("-C", root, "rev-parse", "--absolute-git-dir").then((s) => s.trim()),
  ]);
  const operations = await Promise.all(
    [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "BISECT_LOG",
    ].map((name) =>
      stat(resolve(gitdir, name)).then(
        () => true,
        (error) => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return false;
          throw error;
        },
      ),
    ),
  );
  return {
    repo,
    checkout: {
      root,
      branch: chosen.branch?.startsWith("refs/heads/")
        ? chosen.branch.slice("refs/heads/".length)
        : null,
      head: chosen.head,
      dirty: !!status.trim(),
      operation: operations.some(Boolean),
    },
  };
}

const page = "pageInfo { hasNextPage }";
const author = "author { login __typename } authorAssociation body url id";
export const HEAD_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid state}}}";
export const QUERY = `query Monitor($owner:String!,$repo:String!,$number:Int!) {
  viewer { login }
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    state createdAt author { login } headRefOid baseRefOid headRefName headRepository { nameWithOwner } mergeable
    commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) {
      ${page} nodes {
        ... on CheckRun { id name status conclusion completedAt detailsUrl }
        ... on StatusContext { id context state targetUrl createdAt }
      }
    } } } } }
    comments(first:100) { ${page} nodes { ${author} } }
    reviews(first:100) { ${page} nodes { ${author} state } }
    reviewThreads(first:100) { ${page} nodes { isResolved isOutdated comments(first:100) { ${page} nodes { ${author} } } } }
  } }
}`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Incomplete GitHub response");
  return value as Record<string, unknown>;
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("Incomplete GitHub response");
  return value;
}
function nodes(value: unknown, paginated = true): Record<string, unknown>[] {
  const connection = object(value);
  if (paginated && object(connection.pageInfo).hasNextPage !== false)
    throw new Error("GitHub connection exceeds bounded result limit");
  if (!Array.isArray(connection.nodes))
    throw new Error("Incomplete GitHub response");
  return connection.nodes.map(object);
}
function data(raw: string) {
  const result: unknown = JSON.parse(raw);
  const envelope = object(result);
  if (envelope.errors) throw new Error("Partial GraphQL result rejected");
  return object(envelope.data);
}
function pull(d: Record<string, unknown>) {
  return object(object(d.repository).pullRequest);
}

export function decodeSnapshot(raw: string): Snapshot {
  const d = data(raw);
  const pr = pull(d);
  if (pr.state === "CLOSED" || pr.state === "MERGED")
    return {
      state: str(pr.state).toLowerCase(),
      author: "",
      created: 0,
      head: "",
      base: "",
      branch: "",
      headRepo: "",
      mergeable: null,
      failures: [],
      comments: [],
      viewer: str(object(d.viewer).login),
    };
  const commit = nodes(pr.commits, false)[0];
  if (!commit) throw new Error("Missing PR head commit");
  const rollup = object(commit.commit).statusCheckRollup;
  const checks = rollup === null ? [] : nodes(object(rollup).contexts);
  const created = Date.parse(str(pr.createdAt));
  if (!Number.isFinite(created))
    throw new Error("Invalid GitHub creation time");
  const comments = [
    ...nodes(pr.comments),
    ...nodes(pr.reviews).filter(
      (c) => !["PENDING", "DISMISSED"].includes(String(c.state)),
    ),
    ...nodes(pr.reviewThreads).flatMap((thread) => {
      if (
        typeof thread.isResolved !== "boolean" ||
        typeof thread.isOutdated !== "boolean"
      )
        throw new Error("Incomplete GitHub thread state");
      const comments = nodes(thread.comments);
      return thread.isResolved || thread.isOutdated ? [] : comments;
    }),
  ].map((c): Comment => {
    const a =
      c.author === null
        ? { login: "", __typename: "Deleted" }
        : object(c.author);
    return {
      id: str(c.id),
      body: str(c.body),
      url: str(c.url),
      author: str(a.login),
      association: str(c.authorAssociation),
      bot: a.__typename === "Bot",
    };
  });
  return {
    state: str(pr.state).toLowerCase(),
    author: pr.author === null ? "" : str(object(pr.author).login),
    created,
    head: str(pr.headRefOid),
    base: str(pr.baseRefOid),
    branch: str(pr.headRefName),
    headRepo: str(object(pr.headRepository).nameWithOwner).toLowerCase(),
    mergeable:
      pr.mergeable === "CONFLICTING"
        ? false
        : pr.mergeable === "MERGEABLE"
          ? true
          : null,
    viewer: str(object(d.viewer).login),
    comments,
    failures: checks.flatMap((c) => {
      const failed =
        c.status === "COMPLETED" &&
        [
          "FAILURE",
          "TIMED_OUT",
          "CANCELLED",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
          "STALE",
        ].includes(String(c.conclusion));
      const legacy = c.state === "FAILURE" || c.state === "ERROR";
      if (!failed && !legacy) return [];
      return [
        {
          key: `${str(pr.headRefOid)}:${str(c.id)}:${str(failed ? c.completedAt : c.createdAt)}`,
          name: str(failed ? c.name : c.context),
          url:
            (failed ? c.detailsUrl : c.targetUrl) === null
              ? ""
              : str(failed ? c.detailsUrl : c.targetUrl),
        },
      ];
    }),
  };
}

export class GitHub {
  constructor(private readonly run: Runner) {}
  private query(pr: PR, query: string, signal: AbortSignal) {
    const [owner, repo] = pr.repo.split("/");
    return this.run(
      "gh",
      [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${repo}`,
        "-F",
        `number=${pr.number}`,
      ],
      signal,
    );
  }
  async snapshot(pr: PR, signal: AbortSignal) {
    return decodeSnapshot(await this.query(pr, QUERY, signal));
  }
  async head(pr: PR, signal: AbortSignal) {
    const p = pull(data(await this.query(pr, HEAD_QUERY, signal)));
    return { head: str(p.headRefOid), state: str(p.state).toLowerCase() };
  }
}
