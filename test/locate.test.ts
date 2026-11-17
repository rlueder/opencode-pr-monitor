import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandError,
  type Finder,
  readLocal,
  runner,
  type Runner,
} from "../src/github.ts";
import {
  existingRoots,
  LIMITS,
  Locator,
  scan,
  searchRoots,
} from "../src/locate.ts";

// Real Git repositories in a temporary directory. GIT_CEILING_DIRECTORIES
// keeps Git from discovering a repository above it. node --test runs each
// file in its own process, so this does not leak into other suites.
async function sandbox() {
  const base = await realpath(
    await mkdtemp(
      join(
        process.env.PR_MONITOR_TEST_TMPDIR ?? tmpdir(),
        "pr-monitor-locate-",
      ),
    ),
  );
  process.env.GIT_CEILING_DIRECTORIES = base;
  const run = runner(base);
  const signal = new AbortController().signal;
  const git = (...args: string[]) => run("git", args, signal);
  const repo = async (path: string, origin?: string) => {
    await git("init", "-q", "-b", "main", path);
    if (origin) await git("-C", path, "remote", "add", "origin", origin);
    await git(
      "-C",
      path,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    return path;
  };
  const home = join(base, "home");
  await mkdir(home);
  return {
    base,
    home,
    git,
    repo,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const target = (branch = "fix/x", head = "nohead") => ({
  session: "s1",
  repo: "acme/project",
  branch,
  head,
});

// Counts Git calls so tests can see when a search ran.
function counting(run: Runner) {
  const calls: string[] = [];
  const wrapped: Runner = (file, args, signal) => {
    calls.push(args.join(" "));
    return run(file, args, signal);
  };
  return { calls, run: wrapped };
}

const never: Finder = {
  find: async () => {
    throw new Error("The finder must not run");
  },
  forget: () => {},
};

test("a session inside a checkout of the PR's repository uses it without searching", async () => {
  const s = await sandbox();
  try {
    const session = await s.repo(
      join(s.base, "session"),
      "https://github.com/Acme/Project.git",
    );
    const local = await readLocal(
      session,
      target("main"),
      runner(session),
      new AbortController().signal,
      never,
    );
    assert.equal(local.repo, "acme/project");
    assert.equal(local.found, undefined);
    assert.equal(local.checkout?.root, session);
  } finally {
    await s.cleanup();
  }
});

test("a session in the home directory finds the one checkout whose origin matches", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    // ssh form and different case still match acme/project.
    const project = await s.repo(
      join(roots, "acme", "project"),
      "git@github.com:ACME/Project.git",
    );
    await s.repo(join(roots, "other"), "https://github.com/acme/other.git");
    await s.repo(join(roots, "no-origin"));
    const run = runner(s.home);
    const locator = new Locator(run, async () => [roots]);
    const local = await readLocal(
      s.home,
      target(),
      run,
      new AbortController().signal,
      locator,
    );
    assert.deepEqual(local, {
      repo: "acme/project",
      found: project,
      checkout: null,
    });
  } finally {
    await s.cleanup();
  }
});

test("the linked worktree on the PR branch wins, even outside the search roots, over a clone without it", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    const main = await s.repo(
      join(roots, "project"),
      "https://github.com/acme/project",
    );
    await s.repo(
      join(roots, "project-copy"),
      "https://github.com/acme/project",
    );
    const linked = join(s.base, "elsewhere", "project-fix");
    await s.git("-C", main, "worktree", "add", "-q", "-b", "fix/x", linked);
    const run = runner(s.home);
    const local = await readLocal(
      s.home,
      target("fix/x"),
      run,
      new AbortController().signal,
      new Locator(run, async () => [roots]),
    );
    assert.equal(local.found, main);
    assert.equal(local.checkout?.root, linked);
    assert.equal(local.checkout?.branch, "fix/x");
    assert.equal(local.checkout?.dirty, false);
  } finally {
    await s.cleanup();
  }
});

test("no matching checkout lists what was searched and how to set searchRoots", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    await s.repo(join(roots, "other"), "https://github.com/acme/other.git");
    const run = runner(s.home);
    await assert.rejects(
      readLocal(
        s.home,
        target(),
        run,
        new AbortController().signal,
        new Locator(run, async () => [roots]),
      ),
      (error) =>
        error instanceof Error &&
        error.message.startsWith(
          "No local checkout of acme/project was found",
        ) &&
        error.message.includes(roots) &&
        error.message.includes("1 Git checkouts") &&
        error.message.includes('"searchRoots"'),
    );
    await assert.rejects(
      new Locator(run, async () => []).find(
        target(),
        new AbortController().signal,
      ),
      /none of the default directories .*~\/Github.* exist/,
    );
  } finally {
    await s.cleanup();
  }
});

test("several equally good checkouts are listed instead of guessed", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    const a = await s.repo(join(roots, "a"), "https://github.com/acme/project");
    const b = await s.repo(join(roots, "b"), "git@github.com:acme/project.git");
    const run = runner(s.home);
    await assert.rejects(
      new Locator(run, async () => [roots]).find(
        target(),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof Error &&
        error.message.includes("Found 2 separate checkouts of acme/project") &&
        error.message.includes('none has the PR branch "fix/x"') &&
        error.message.includes(a) &&
        error.message.includes(b) &&
        error.message.includes("Not guessing"),
    );
  } finally {
    await s.cleanup();
  }
});

test("worktrees of one repository found under the roots count as one checkout", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    const main = await s.repo(
      join(roots, "platform"),
      "https://github.com/acme/project",
    );
    await s.git(
      "-C",
      main,
      "worktree",
      "add",
      "-q",
      "-b",
      "other",
      join(roots, "platform-other"),
    );
    const run = runner(s.home);
    assert.equal(
      await new Locator(run, async () => [roots]).find(
        target(),
        new AbortController().signal,
      ),
      main,
    );
  } finally {
    await s.cleanup();
  }
});

test("results are cached per session and repository, and searched again when stale", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    const project = await s.repo(
      join(roots, "project"),
      "https://github.com/acme/project",
    );
    const counter = counting(runner(s.home));
    const locator = new Locator(counter.run, async () => [roots]);
    const signal = new AbortController().signal;
    assert.equal(await locator.find(target(), signal), project);
    const first = counter.calls.length;
    assert.equal(await locator.find(target(), signal), project);
    // Only the origin of the cached checkout is re-read.
    assert.deepEqual(counter.calls.slice(first), [
      `-C ${project} remote get-url origin`,
    ]);
    // Another session searches on its own.
    await locator.find({ ...target(), session: "s2" }, signal);
    assert.ok(counter.calls.length > first + 2);
    // A moved checkout is searched for again.
    await rm(project, { recursive: true, force: true });
    const moved = await s.repo(
      join(roots, "moved"),
      "https://github.com/acme/project",
    );
    assert.equal(await locator.find(target(), signal), moved);
  } finally {
    await s.cleanup();
  }
});

test("the search is depth-limited, directory-capped and time-boxed", async () => {
  const s = await sandbox();
  try {
    const roots = join(s.base, "Github");
    await s.repo(
      join(roots, "a", "b", "too-deep"),
      "https://github.com/acme/project",
    );
    const signal = new AbortController().signal;
    const shallow = await scan([roots], LIMITS, Date.now() + 5000, signal);
    assert.deepEqual(shallow, { found: [], complete: true });
    const deep = await scan(
      [roots],
      { ...LIMITS, depth: 3 },
      Date.now() + 5000,
      signal,
    );
    assert.deepEqual(deep.found, [join(roots, "a", "b", "too-deep")]);
    const run = runner(s.home);
    await assert.rejects(
      new Locator(run, async () => [roots], { ...LIMITS, directories: 2 }).find(
        target(),
        signal,
      ),
      /visited more than 2 directories/,
    );
    // A Git call that never finishes cannot hang the search.
    await s.repo(join(roots, "slow"), "https://github.com/acme/project");
    const hanging: Runner = (_file, _args, signal) =>
      new Promise((_accept, reject) =>
        signal.addEventListener("abort", () =>
          reject(new CommandError("git remote get-url", "aborted")),
        ),
      );
    const started = Date.now();
    await assert.rejects(
      new Locator(hanging, async () => [roots], {
        ...LIMITS,
        timeout: 200,
      }).find(target(), signal),
      /took longer than 0.2 s/,
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    await s.cleanup();
  }
});

test("searchRoots option accepts absolute and ~/ paths and rejects anything else", async () => {
  assert.equal(searchRoots({}, "/home/r"), undefined);
  assert.deepEqual(
    searchRoots({ searchRoots: ["~/Github", "/srv/code", "~"] }, "/home/r"),
    ["/home/r/Github", "/srv/code", "/home/r"],
  );
  assert.throws(() => searchRoots({ searchRoots: "~/Github" }), /list/);
  assert.throws(
    () => searchRoots({ searchRoots: ["relative/dir"] }),
    /absolute or ~\//,
  );
  const s = await sandbox();
  try {
    const dir = join(s.base, "Github");
    await mkdir(dir);
    assert.deepEqual(
      await existingRoots([dir, join(s.base, "missing"), `${dir}/.`]),
      [dir],
    );
  } finally {
    await s.cleanup();
  }
});
