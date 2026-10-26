import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CreationCalls,
  directCreate,
  createdURL,
  watchCreations,
} from "../src/creation.ts";

test("only direct literal PR creation commands qualify, not mentions or shell wrappers", () => {
  for (const command of [
    "gh pr create --title 'A fix' --body 'Details\nMore details'",
    "gh pr create --body-file /work/body.md",
    'gh pr create --title "A fix" --body "literal \\$HOME"',
  ])
    assert.equal(
      directCreate("shell", { command, workdir: "/work" }, "/work"),
      true,
      command,
    );
  for (const command of [
    "echo 'gh pr create'",
    "gh pr view",
    "gh pr create; gh pr view",
    "gh pr create && echo done",
    "gh pr create | cat",
    "gh pr create > /work/out",
    'gh pr create --body "$BODY"',
    "gh pr create --body `cat file`",
    "gh pr create --body $(cat file)",
    "gh pr create\necho done",
    "env gh pr create",
    "gh pr create --body 'unterminated",
    "gh pr create \\",
  ])
    assert.equal(directCreate("shell", { command }, "/work"), false, command);
  assert.equal(
    directCreate("webfetch", { command: "gh pr create" }, "/work"),
    false,
  );
  assert.equal(
    directCreate(
      "shell",
      { command: "gh pr create", workdir: "/elsewhere" },
      "/work",
    ),
    false,
  );
});

test("creation result requires a single standalone exact PR URL", () => {
  const url = "https://github.com/acme/project/pull/42";
  assert.equal(createdURL(`Creating pull request\n${url}\n`), url);
  for (const text of [
    `Mention ${url}`,
    `[PR](${url})`,
    `${url}\n${url}`,
    `${url}?x=1`,
    "",
    "https://evil.test/acme/project/pull/42",
  ])
    assert.equal(createdURL(text), undefined);
});

test("creation observer registers live tool hooks and disposes both", async () => {
  const names: string[] = [];
  let disposed = 0;
  const stop = await watchCreations(
    {
      hook: async (name) => {
        names.push(name);
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
    "/work",
    async () => {
      assert.fail("No live tool call");
    },
  );
  assert.deepEqual(names, ["execute.before", "execute.after"]);
  await stop();
  assert.equal(disposed, 2);
});

test("live before/after pairs are session-isolated, nonblocking and consumed once", async () => {
  const observed: unknown[] = [];
  let now = 1000;
  let release!: () => void;
  const calls = new CreationCalls(
    "/work",
    async (...args) => {
      observed.push(args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    () => now,
  );
  const input = { command: "gh pr create" };
  const url = "https://github.com/acme/project/pull/42";
  calls.after("s1", "history", "shell", input, url);
  calls.before("s1", "a", "shell", input);
  calls.after("s2", "a", "shell", input, url);
  assert.deepEqual(observed, []);
  now = 2000;
  assert.equal(calls.after("s1", "a", "shell", input, url), undefined);
  assert.deepEqual(observed, [["s1", url, 1000, 2000]]);
  calls.after("s1", "a", "shell", input, url);
  calls.before("s1", "error", "shell", input);
  calls.after("s1", "error", "shell", input);
  calls.after("s1", "error", "shell", input, url);
  assert.equal(observed.length, 1);
  calls.before("s1", "late", "shell", input);
  calls.close();
  calls.after("s1", "late", "shell", input, url);
  calls.before("s1", "post-unload", "shell", input);
  calls.after("s1", "post-unload", "shell", input, url);
  assert.equal(observed.length, 1);
  release();
});
