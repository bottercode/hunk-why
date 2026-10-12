import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUnifiedDiff, readWorkingTreeHunks } from "./hunks";
import { explainWorkingTree } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run git synchronously in a test repository. */
function testGit(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** Create a repository with one old commit, plus an empty Claude Code projects directory. */
function createTestWorkspace() {
  // realpath keeps paths comparable with git's output on macOS, where /var links to /private/var.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hunk-why-test-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const projects = path.join(root, "projects");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(projects, "encoded-repo"), { recursive: true });

  testGit(repo, ["init", "-q"]);
  writeFileSync(path.join(repo, "src", "api.ts"), "export function fetchUser() {\n  return request();\n}\n");
  testGit(repo, ["add", "-A"]);
  const old = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  testGit(repo, ["-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qm", "base"], old);
  return { repo, projects };
}

/** Write one transcript recording an Edit tool call and a shell-written test file. */
function writeTestTranscript(projects: string, repo: string) {
  const time = new Date().toISOString();
  const records = [
    { type: "user", cwd: repo, timestamp: time, message: { role: "user", content: "Add a retry" } },
    {
      type: "assistant",
      cwd: repo,
      timestamp: time,
      message: {
        content: [
          { type: "text", text: "Timeouts are transient, so retry three times." },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: path.join(repo, "src", "api.ts"), old_string: "x", new_string: "  return retryRequest(3);" },
          },
          { type: "tool_use", name: "Bash", input: { command: "cat > src/api.test.ts <<EOF\nexpect(fetchUserWithRetry()).toBeTruthy();\nEOF" } },
        ],
      },
    },
  ];
  writeFileSync(
    path.join(projects, "encoded-repo", "11111111-2222.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

describe("explainWorkingTree", () => {
  test("explains agent hunks and leaves hand-written ones without notes", async () => {
    const { repo, projects } = createTestWorkspace();
    writeFileSync(path.join(repo, "src", "api.ts"), "export function fetchUser() {\n  return retryRequest(3);\n}\n");
    writeFileSync(path.join(repo, "src", "api.test.ts"), "expect(fetchUserWithRetry()).toBeTruthy();\n");
    writeFileSync(path.join(repo, "notes.md"), "a hand-written note nobody asked the agent for\n");
    writeTestTranscript(projects, repo);

    const result = await explainWorkingTree(path.join(repo, "src"), projects);

    expect(result.explained).toBe(2);
    expect(result.comparable).toBe(3);
    expect(result.context.files.map((file) => [file.path, file.annotations[0]!.newRange])).toEqual([
      ["src/api.ts", [2, 2]],
      ["src/api.test.ts", [1, 1]],
    ]);
  });

  test("ignores transcripts last modified before the latest commit", async () => {
    const { repo, projects } = createTestWorkspace();
    writeFileSync(path.join(repo, "src", "api.ts"), "export function fetchUser() {\n  return retryRequest(3);\n}\n");
    writeTestTranscript(projects, repo);
    testGit(repo, ["-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qam", "later"]);
    writeFileSync(path.join(repo, "src", "api.ts"), "export function fetchUser() {\n  return retryRequest(3); // tweak\n}\n");
    // Commit timestamps have one-second resolution, so wait past the transcript's mtime.
    await Bun.sleep(1100);
    testGit(repo, ["-c", "user.email=t@test", "-c", "user.name=t", "commit", "-qam", "latest"]);
    writeFileSync(path.join(repo, "src", "api.ts"), "export function fetchUser() {\n  return retryRequest(3);\n}\n");

    const result = await explainWorkingTree(repo, projects);

    expect(result.sessionCount).toBe(0);
    expect(result.explained).toBe(0);
  });

  test("explains a fresh repository without any commits", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hunk-why-test-")));
    roots.push(root);
    testGit(root, ["init", "-q"]);
    writeFileSync(path.join(root, "first.ts"), "export const created = true;\n");

    const { hunks, headTime } = await readWorkingTreeHunks(root);

    expect(headTime).toBe(0);
    expect(hunks).toEqual([{ file: "first.ts", newStart: 1, added: ["export const created = true;"] }]);
  });

  test("reports a clear error outside a Git repository", async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hunk-why-test-")));
    roots.push(outside);

    await expect(explainWorkingTree(outside, outside)).rejects.toThrow("inside a Git repository");
  });
});

describe("parseUnifiedDiff", () => {
  test("keeps new-side starts, skips deleted files, and keeps deletion-only hunks empty", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3,2 @@",
      "-old",
      "+new one",
      "+new two",
      "@@ -9,2 +10,0 @@",
      "-gone",
      "-gone too",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { file: "a.ts", newStart: 3, added: ["new one", "new two"] },
      { file: "a.ts", newStart: 10, added: [] },
    ]);
  });
});
