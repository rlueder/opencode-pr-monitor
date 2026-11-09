import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeSnapshot,
  GitHub,
  parseWorktrees,
  readLocal,
  remoteRepo,
  runner,
} from "../src/github.ts";
import { parsePR } from "../src/types.ts";

const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false },
});
function response(checks: unknown[] = []) {
  return {
    data: {
      viewer: { login: "me" },
      repository: {
        pullRequest: {
          state: "OPEN",
          author: { login: "me" },
          createdAt: "2026-10-25T22:15:00Z",
          headRefOid: "sha1",
          baseRefOid: "base1",
          headRefName: "fix",
          headRepository: { nameWithOwner: "Acme/Project" },
          mergeable: "UNKNOWN",
          commits: {
            nodes: [
              {
                commit: { statusCheckRollup: { contexts: connection(checks) } },
              },
            ],
          },
          comments: connection([]),
          reviews: connection([]),
          reviewThreads: connection([]),
        },
      },
    },
  };
}
test("terminal CI conclusions and legacy statuses, pending not failure", () => {
  const checks = [
    { id: "1", name: "pending", status: "IN_PROGRESS", conclusion: "FAILURE" },
    { id: "2", name: "passed", status: "COMPLETED", conclusion: "SUCCESS" },
    {
      id: "3",
      name: "failed",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-10-24",
      detailsUrl: "https://github.com/x",
    },
    {
      id: "4",
      context: "legacy",
      state: "ERROR",
      createdAt: "2026-10-24",
      targetUrl: null,
    },
    { id: "5", context: "waiting", state: "PENDING" },
    { id: "6", name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL" },
  ];
  const s = decodeSnapshot(JSON.stringify(response(checks)));
  assert.equal(s.mergeable, null);
  assert.equal(s.headRepo, "acme/project");
  assert.deepEqual(
    s.failures.map((f) => f.name),
    ["failed", "legacy"],
  );
  assert.match(s.failures[0]!.key, /sha1:3:2026/);
});

test("unknown mergeability conservative, closed head may be deleted", () => {
  const r = response();
  const p = r.data.repository.pullRequest;
  p.mergeable = "CONFLICTING";
  assert.equal(decodeSnapshot(JSON.stringify(r)).mergeable, false);
  p.mergeable = "MERGEABLE";
  assert.equal(decodeSnapshot(JSON.stringify(r)).mergeable, true);
  assert.equal(
    decodeSnapshot(
      JSON.stringify({
        data: {
          viewer: { login: "me" },
          repository: { pullRequest: { state: "MERGED" } },
        },
      }),
    ).state,
    "merged",
  );
});

test("comments, reviews, inline replies, Bot and deleted authors decoded", () => {
  const r = response();
  const p = r.data.repository.pullRequest;
  const c = {
    id: "c1",
    author: { login: "app[bot]", __typename: "Bot" },
    body: "body",
    authorAssociation: "NONE",
    url: "url",
  };
  p.comments = connection([c]);
  p.reviews = connection([
    { ...c, id: "review", state: "CHANGES_REQUESTED" },
    { ...c, id: "draft", state: "PENDING" },
  ]);
  p.reviewThreads = connection([
    {
      isResolved: false,
      isOutdated: false,
      comments: connection([{ ...c, id: "inline", author: null }]),
    },
  ]);
  const s = decodeSnapshot(JSON.stringify(r));
  assert.deepEqual(
    s.comments.map((c) => c.id),
    ["c1", "review", "inline"],
  );
  assert.equal(s.comments[0]?.bot, true);
  assert.equal(s.comments[2]?.author, "");
});

test("partial errors, overflow connections and malformed data rejected", () => {
  assert.throws(() =>
    decodeSnapshot(
      JSON.stringify({ ...response(), errors: [{ message: "partial" }] }),
    ),
  );
  const r = response();
  r.data.repository.pullRequest.comments.pageInfo.hasNextPage = true;
  assert.throws(() => decodeSnapshot(JSON.stringify(r)), /bounded/);
  r.data.repository.pullRequest.comments = connection([{}]);
  assert.throws(() => decodeSnapshot(JSON.stringify(r)), /Incomplete/);
  assert.throws(() => decodeSnapshot("{}"));
  assert.throws(() => decodeSnapshot("not json"));
});

test("activation evidence and unresolved thread filtering come from GitHub", () => {
  const r = response();
  const c = {
    id: "c",
    author: { login: "reviewer", __typename: "User" },
    body: "fix",
    authorAssociation: "MEMBER",
    url: "url",
  };
  r.data.repository.pullRequest.reviewThreads = connection([
    {
      isResolved: true,
      isOutdated: false,
      comments: connection([{ ...c, id: "resolved" }]),
    },
    {
      isResolved: false,
      isOutdated: true,
      comments: connection([{ ...c, id: "outdated" }]),
    },
    { isResolved: false, isOutdated: false, comments: connection([c]) },
  ]);
  r.data.repository.pullRequest.reviews = connection([
    { ...c, id: "dismissed", state: "DISMISSED" },
  ]);
  const snap = decodeSnapshot(JSON.stringify(r));
  assert.equal(snap.author, "me");
  assert.equal(snap.created, Date.parse("2026-10-25T22:15:00Z"));
  assert.deepEqual(
    snap.comments.map((c) => c.id),
    ["c"],
  );
  r.data.repository.pullRequest.reviewThreads = connection([
    { comments: connection([c]) },
  ]);
  assert.throws(() => decodeSnapshot(JSON.stringify(r)), /thread state/);
});

test("remote identity rejects credentials, foreign hosts and URL suffixes", () => {
  for (const url of [
    "git@github.com:Acme/Project.git",
    "https://github.com/Acme/Project.git",
    "ssh://git@github.com/Acme/Project.git",
  ])
    assert.equal(remoteRepo(url), "acme/project");
  for (const url of [
    "https://token@github.com/acme/project",
    "https://github.com.evil/acme/project",
    "https://enterprise/acme/project",
    "https://github.com/acme/project?x=1",
  ])
    assert.throws(() => remoteRepo(url));
});

test("GitHub adapter uses bounded read-only graphql argv, including fresh head", async () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const gh = new GitHub(async (file, args) => {
    calls.push({ file, args });
    return args.includes(
      `query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid state}}}`,
    )
      ? JSON.stringify({
          data: {
            repository: { pullRequest: { state: "OPEN", headRefOid: "sha1" } },
          },
        })
      : JSON.stringify(response());
  });
  const signal = new AbortController().signal;
  await gh.snapshot(parsePR("https://github.com/acme/project/pull/42"), signal);
  assert.deepEqual(
    await gh.head(parsePR("https://github.com/acme/project/pull/42"), signal),
    { head: "sha1", state: "open" },
  );
  for (const c of calls) {
    assert.equal(c.file, "gh");
    assert.deepEqual(c.args.slice(0, 4), [
      "api",
      "graphql",
      "--hostname",
      "github.com",
    ]);
    assert.ok(c.args.includes("number=42"));
    assert.ok(!c.args.some((a) => a.includes("mutation")));
  }
});

test("subprocess argv is literal, stderr not leaked, exit/output/timeout/abort bounded", async () => {
  const run = runner(process.cwd(), 3000, 5000);
  const signal = new AbortController().signal;
  assert.equal(
    await run(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "$(touch never); quoted"],
      signal,
    ),
    "$(touch never); quoted",
  );
  await assert.rejects(
    run(
      process.execPath,
      ["-e", "console.error('secret');process.exit(1)"],
      signal,
    ),
    (error) => error instanceof Error && !error.message.includes("secret"),
  );
  await assert.rejects(
    run(process.execPath, ["-e", "console.log('x'.repeat(10000))"], signal),
    /limit/,
  );
  await assert.rejects(
    runner(process.cwd(), 30)(
      process.execPath,
      ["-e", "setTimeout(()=>{},10000)"],
      signal,
    ),
    /timed out/,
  );
  const controller = new AbortController();
  const task = run(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    controller.signal,
  );
  controller.abort();
  await assert.rejects(task, /aborted/);
  await assert.rejects(
    run(process.execPath, ["-e", ""], controller.signal),
    /aborted/i,
  );
  await assert.rejects(run("/no-such-program-pr-monitor", [], signal));
});

// Builds `git worktree list --porcelain -z` output.
function porcelain(...records: string[][]) {
  return records
    .map((lines) => lines.map((l) => `${l}\0`).join("") + "\0")
    .join("");
}

async function tempDirs(...names: string[]) {
  const base = await realpath(
    await mkdtemp(
      join(process.env.PR_MONITOR_TEST_TMPDIR ?? tmpdir(), "pr-monitor-local-"),
    ),
  );
  const dirs = names.map((name) => join(base, name));
  for (const dir of dirs) await mkdir(join(dir, ".git"), { recursive: true });
  return { base, dirs };
}

// A read-only fake of the Git commands readLocal may run. Anything else fails.
function fakeGit(list: string, gitdirs: Record<string, string>, status = "") {
  const commands: string[] = [];
  return {
    commands,
    run: async (file: string, args: readonly string[]) => {
      assert.equal(file, "git");
      const command = args.join(" ");
      commands.push(command);
      if (command === "remote get-url origin")
        return "git@github.com:acme/project.git\n";
      if (command === "worktree list --porcelain -z") return list;
      const match =
        /^-C (.+) (status --porcelain --untracked-files=normal|rev-parse --absolute-git-dir)$/.exec(
          command,
        );
      const root = match?.[1];
      if (root === undefined || !(root in gitdirs))
        throw new Error(`Unexpected Git command: ${command}`);
      return match?.[2]?.startsWith("status") ? status : `${gitdirs[root]}\n`;
    },
  };
}

test("worktree list parsing keeps branch, detached, bare and prunable entries apart", () => {
  const trees = parseWorktrees(
    porcelain(
      ["worktree /repo", "HEAD aaa", "branch refs/heads/main"],
      ["worktree /repo-fix", "HEAD bbb", "branch refs/heads/fix/x"],
      ["worktree /repo-detached", "HEAD ccc", "detached"],
      [
        "worktree /repo-gone",
        "HEAD ddd",
        "branch refs/heads/old",
        "prunable gitdir file points to non-existent location",
      ],
      ["worktree /repo.git", "bare"],
    ),
  );
  assert.deepEqual(
    trees.map((t) => [t.path, t.head, t.branch, t.bare, t.prunable]),
    [
      ["/repo", "aaa", "refs/heads/main", false, false],
      ["/repo-fix", "bbb", "refs/heads/fix/x", false, false],
      ["/repo-detached", "ccc", null, false, false],
      ["/repo-gone", "ddd", "refs/heads/old", false, true],
      ["/repo.git", null, null, true, false],
    ],
  );
  assert.throws(() => parseWorktrees("HEAD aaa\0\0"), /Malformed/);
});

test("PR checkout resolves to the worktree that has the PR branch, not the session directory", async () => {
  const { base, dirs } = await tempDirs("session", "pr");
  const [session, pr] = dirs as [string, string];
  try {
    await writeFile(join(pr, ".git", "MERGE_HEAD"), "synthetic");
    const git = fakeGit(
      porcelain(
        [
          `worktree ${session}`,
          "HEAD aaa",
          "branch refs/heads/park/experiments",
        ],
        [`worktree ${pr}`, "HEAD sha1", "branch refs/heads/fix/dexa"],
      ),
      { [pr]: join(pr, ".git") },
      "?? dirty",
    );
    const local = await readLocal(
      session,
      { branch: "fix/dexa", head: "sha1" },
      git.run,
      new AbortController().signal,
    );
    assert.deepEqual(local, {
      repo: "acme/project",
      checkout: {
        root: pr,
        branch: "fix/dexa",
        head: "sha1",
        dirty: true,
        operation: true,
      },
    });
    // Only reads: origin, the worktree list, and status/git-dir in the PR checkout.
    assert.deepEqual(git.commands.sort(), [
      `-C ${pr} rev-parse --absolute-git-dir`,
      `-C ${pr} status --porcelain --untracked-files=normal`,
      "remote get-url origin",
      "worktree list --porcelain -z",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("no worktree with the PR branch yields no checkout instead of an error", async () => {
  const { base, dirs } = await tempDirs("session");
  const [session] = dirs as [string];
  try {
    const git = fakeGit(
      porcelain(
        [`worktree ${session}`, "HEAD aaa", "branch refs/heads/main"],
        ["worktree /missing", "HEAD sha1", "branch refs/heads/old", "prunable"],
      ),
      {},
    );
    const local = await readLocal(
      session,
      { branch: "fix", head: "sha1" },
      git.run,
      new AbortController().signal,
    );
    assert.deepEqual(local, { repo: "acme/project", checkout: null });
    assert.equal(git.commands.length, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a detached worktree at the PR head is used, preferring the session directory", async () => {
  const { base, dirs } = await tempDirs("other", "session");
  const [other, session] = dirs as [string, string];
  try {
    const git = fakeGit(
      porcelain(
        [`worktree ${other}`, "HEAD sha1", "detached"],
        [`worktree ${session}`, "HEAD sha1", "detached"],
      ),
      { [session]: join(session, ".git") },
    );
    const local = await readLocal(
      session,
      { branch: "fix", head: "sha1" },
      git.run,
      new AbortController().signal,
    );
    assert.equal(local.checkout?.root, session);
    assert.equal(local.checkout?.branch, null);
    assert.equal(local.checkout?.dirty, false);
    assert.equal(local.checkout?.operation, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readLocal against a real repository with a linked worktree", async () => {
  const { base } = await tempDirs();
  const main = join(base, "main");
  const linked = join(base, "linked");
  const run = runner(base);
  const signal = new AbortController().signal;
  const git = (...args: string[]) => run("git", args, signal);
  try {
    await git("init", "-q", "-b", "main", main);
    await git(
      "-C",
      main,
      "remote",
      "add",
      "origin",
      "https://github.com/Acme/Project.git",
    );
    await git(
      "-C",
      main,
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
    await git("-C", main, "worktree", "add", "-q", "-b", "fix/x", linked);
    const head = (await git("-C", linked, "rev-parse", "HEAD")).trim();
    const local = await readLocal(
      await realpath(main),
      { branch: "fix/x", head },
      runner(main),
      signal,
    );
    assert.equal(local.repo, "acme/project");
    assert.equal(local.checkout?.root, await realpath(linked));
    assert.equal(local.checkout?.branch, "fix/x");
    assert.equal(local.checkout?.head, head);
    assert.equal(local.checkout?.dirty, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test(
  "timeout kills the owned descendant process group, closing inherited pipes",
  { timeout: 3000 },
  async () => {
    const code = `
    require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: ["ignore", process.stdout, process.stderr]
    });
    setTimeout(() => {}, 10000);
  `;
    await assert.rejects(
      runner(process.cwd(), 150)(
        process.execPath,
        ["-e", code],
        new AbortController().signal,
      ),
    );
  },
);
