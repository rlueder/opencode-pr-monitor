import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CommandError,
  type Finder,
  parseWorktrees,
  remoteRepo,
  type Runner,
} from "./github.ts";
import type { Target } from "./types.ts";

// Directory names under the home directory that commonly hold checkouts. Only
// those that exist are searched; the home directory itself never is.
export const DEFAULT_ROOTS = [
  "Github",
  "GitHub",
  "github",
  "Code",
  "code",
  "src",
  "Projects",
  "projects",
  "Developer",
  "dev",
  "repos",
  "workspace",
];

export type Limits = {
  // Levels below each root: 2 covers ~/Github/repo and ~/Github/org/repo.
  depth: number;
  // Directories visited across all roots before the search gives up.
  directories: number;
  // Wall-clock budget for the scan and every Git call it makes.
  timeout: number;
};
export const LIMITS: Limits = { depth: 2, directories: 5_000, timeout: 10_000 };

const HINT =
  'Start the session in a checkout of the repository, or list the directories that hold your checkouts in this plugin\'s options in opencode.jsonc: { "package": "/path/to/opencode-pr-monitor", "options": { "searchRoots": ["~/Github"] } }.';

// Reads `searchRoots` from the plugin options: absolute paths or `~/...`.
export function searchRoots(
  options: Readonly<Record<string, unknown>>,
  home = homedir(),
): string[] | undefined {
  const value = options.searchRoots;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((v): v is string => typeof v === "string" && !!v.trim())
  )
    throw new Error(
      'opencode-pr-monitor option "searchRoots" must be a list of directory paths',
    );
  return value.map((v) => {
    const path =
      v === "~" ? home : v.startsWith("~/") ? join(home, v.slice(2)) : v;
    if (!isAbsolute(path))
      throw new Error(
        `opencode-pr-monitor option "searchRoots" needs absolute or ~/ paths, not ${JSON.stringify(v)}`,
      );
    return path;
  });
}

// Existing directories, deduplicated by inode so case-insensitive file systems
// do not search ~/Github and ~/github twice.
export async function existingRoots(paths: readonly string[]) {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      const id = `${info.dev}:${info.ino}`;
      if (!info.isDirectory() || seen.has(id)) continue;
      seen.add(id);
      roots.push(await realpath(path));
    } catch {
      // Missing roots are skipped.
    }
  }
  return roots;
}

export const defaultRoots = (home = homedir()) =>
  existingRoots(DEFAULT_ROOTS.map((name) => join(home, name)));

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Breadth-first, depth-limited walk that returns directories containing a
// `.git` entry. It does not descend into checkouts, hidden directories,
// node_modules or symbolic links. `complete` is false when a cap stopped it.
export async function scan(
  roots: readonly string[],
  limits: Limits,
  deadline: number,
  signal: AbortSignal,
) {
  const queue = roots.map((dir) => ({ dir, level: 0 }));
  const found: string[] = [];
  let visited = 0;
  for (let item = queue.shift(); item; item = queue.shift()) {
    if (signal.aborted) throw new Error("Operation aborted");
    if (++visited > limits.directories || Date.now() > deadline)
      return { found, complete: false };
    if (await exists(join(item.dir, ".git"))) {
      found.push(item.dir);
      continue;
    }
    if (item.level >= limits.depth) continue;
    let entries;
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      )
        queue.push({ dir: join(item.dir, entry.name), level: item.level + 1 });
  }
  return { found, complete: true };
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return results;
}

const real = (path: string) => realpath(path).catch(() => undefined);

type Repository = {
  // Main worktree, or the found checkout when the main one is bare or gone.
  anchor: string;
  paths: Set<string>;
  // A worktree has the PR branch, or is detached at the PR head.
  hasBranch: boolean;
};

// Finds a local checkout of the PR's repository when the session directory is
// not one. Only read-only Git commands run, always as `git -C <dir>`.
export class Locator implements Finder {
  private cache = new Map<string, string>();
  constructor(
    private readonly run: Runner,
    private readonly roots: () => Promise<string[]>,
    private readonly limits: Limits = LIMITS,
  ) {}

  forget(target: Target) {
    this.cache.delete(`${target.session}\0${target.repo}`);
  }

  async find(target: Target, signal: AbortSignal): Promise<string> {
    const key = `${target.session}\0${target.repo}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Reuse the earlier result only while it is still a checkout of the repo.
      const origin = await this.run(
        "git",
        ["-C", cached, "remote", "get-url", "origin"],
        signal,
      ).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return "";
      });
      if (this.matches(origin, target.repo)) return cached;
      this.cache.delete(key);
    }
    const found = await this.search(target, signal);
    this.cache.set(key, found);
    return found;
  }

  private matches(origin: string, repo: string) {
    try {
      return remoteRepo(origin) === repo;
    } catch {
      return false;
    }
  }

  private async search(target: Target, signal: AbortSignal) {
    const { repo, branch, head } = target;
    const roots = await this.roots();
    if (!roots.length)
      throw new Error(
        `No local checkout of ${repo} could be searched for: none of the default directories (${DEFAULT_ROOTS.map((n) => `~/${n}`).join(", ")}) exist. ${HINT}`,
      );
    const timeout = AbortSignal.timeout(this.limits.timeout);
    const scoped = AbortSignal.any([signal, timeout]);
    const searched = `${roots.join(", ")} (up to ${this.limits.depth} levels deep)`;
    const tooSlow = () =>
      new Error(
        `Searching ${searched} for a checkout of ${repo} took longer than ${this.limits.timeout / 1000} s or visited more than ${this.limits.directories} directories. ${HINT}`,
      );
    const git = (dir: string, ...args: string[]) =>
      this.run("git", ["-C", dir, ...args], scoped);
    try {
      const { found, complete } = await scan(
        roots,
        this.limits,
        Date.now() + this.limits.timeout,
        scoped,
      );
      if (!complete) throw tooSlow();
      const matches = (
        await pool(found, 8, async (dir) => {
          try {
            return this.matches(
              await git(dir, "remote", "get-url", "origin"),
              repo,
            )
              ? dir
              : undefined;
          } catch (error) {
            if (scoped.aborted) throw error;
            return undefined;
          }
        })
      ).filter((dir): dir is string => dir !== undefined);
      // Checkouts that are worktrees of one repository count once.
      const repositories: Repository[] = [];
      for (const dir of matches) {
        const path = (await real(dir)) ?? dir;
        if (repositories.some((r) => r.paths.has(path))) continue;
        const trees = parseWorktrees(
          await git(dir, "worktree", "list", "--porcelain", "-z"),
        );
        const paths = new Set([path]);
        for (const tree of trees) {
          const p = await real(tree.path);
          if (p) paths.add(p);
        }
        const main = trees[0];
        const mainPath = main && !main.bare ? await real(main.path) : undefined;
        repositories.push({
          anchor: mainPath ?? path,
          paths,
          hasBranch: trees.some(
            (t) =>
              !t.bare &&
              !t.prunable &&
              !!t.head &&
              (t.branch === `refs/heads/${branch}` ||
                (t.branch === null && t.head === head)),
          ),
        });
      }
      if (!repositories.length)
        throw new Error(
          `No local checkout of ${repo} was found: searched ${searched}, ${found.length} Git checkouts, for an origin remote on github.com/${repo}. ${HINT}`,
        );
      const best = repositories.some((r) => r.hasBranch)
        ? repositories.filter((r) => r.hasBranch)
        : repositories;
      if (best.length > 1)
        throw new Error(
          `Found ${best.length} separate checkouts of ${repo}, and ${
            best[0]?.hasBranch
              ? `each has the PR branch ${JSON.stringify(branch)}`
              : `none has the PR branch ${JSON.stringify(branch)}`
          }: ${best.map((r) => r.anchor).join(", ")}. Not guessing between them. Start the session in the one to use, or narrow "searchRoots". ${HINT}`,
        );
      return (best[0] as Repository).anchor;
    } catch (error) {
      if (!signal.aborted && timeout.aborted) throw tooSlow();
      if (
        error instanceof CommandError &&
        error.reason !== "aborted" &&
        !signal.aborted
      )
        throw new Error(
          `Searching for a checkout of ${repo} failed: ${error.message}.`,
        );
      throw error;
    }
  }
}
