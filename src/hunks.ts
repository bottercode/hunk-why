/**
 * Collects the hunks `hunk diff` reviews by default: tracked changes against HEAD plus untracked
 * files. Hunks are zero-context so each one's added lines are exactly what an edit must explain,
 * and line numbers are new-side (working tree) numbers, which is what agent-context notes anchor to.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ChangedHunk {
  file: string;
  /** First working-tree line of the hunk (1-based). */
  newStart: number;
  /** Added lines, in order, without the leading `+`. */
  added: string[];
}

// Untracked files larger than this are skipped rather than read whole.
const MAX_UNTRACKED_BYTES = 1024 * 1024;

/** Run git in `cwd` and return stdout, or throw with git's own message. */
export async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed with exit ${code}`);
  return stdout;
}

/** Split a zero-context unified diff into hunks with added lines; deletion-only hunks are kept empty. */
export function parseUnifiedDiff(patch: string): ChangedHunk[] {
  const hunks: ChangedHunk[] = [];
  let file: string | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? undefined : line.slice(4).replace(/^b\//, "");
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header && file) {
      hunks.push({ file, newStart: Number(header[1]), added: [] });
      continue;
    }
    if (line.startsWith("+") && hunks.length && file) hunks.at(-1)!.added.push(line.slice(1));
  }
  return hunks;
}

/** Return working-tree hunks against HEAD (or the empty tree before the first commit). */
export async function readWorkingTreeHunks(repoRoot: string, signal?: AbortSignal) {
  const hasHead = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).then(
    () => true,
    () => false,
  );
  // 4b825dc6… is git's well-known empty tree, so a repo without commits diffs against nothing.
  const base = hasHead ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const patch = await git(
    repoRoot,
    ["diff", base, "--unified=0", "--no-color", "--no-renames", "--no-ext-diff"],
    signal,
  );
  const hunks = parseUnifiedDiff(patch);

  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
  for (const file of untracked.split("\0").filter(Boolean)) {
    const absolute = path.join(repoRoot, file);
    if ((await stat(absolute)).size > MAX_UNTRACKED_BYTES) continue;
    const text = await readFile(absolute, "utf8");
    if (text.includes("\0")) continue;
    hunks.push({ file, newStart: 1, added: text.replace(/\n$/, "").split("\n") });
  }
  return { hunks, headTime: hasHead ? Number((await git(repoRoot, ["log", "-1", "--format=%ct"], signal)).trim()) * 1000 : 0 };
}
