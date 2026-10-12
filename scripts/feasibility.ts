#!/usr/bin/env bun

/**
 * Measures how many committed diff hunks can be traced back to the Claude Code edit that wrote
 * them. Prints totals only: no file paths, project names, code, or transcript text.
 *
 * For each transcript it collects the edits the agent made (Edit, MultiEdit, Write, and Bash
 * commands that look like file writes), finds commits the repo's configured user authored while
 * the session ran, and checks whether each commit hunk's added lines appear in one of those edits.
 * Commits by other authors (for example upstream work pulled during the session) are only counted.
 *
 * Usage: bun feasibility.ts [projectsDir]   (defaults to ~/.claude/projects)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectsDir = process.argv[2] ?? path.join(os.homedir(), ".claude", "projects");
const LOCKFILES = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/;
const BASH_WRITE = /<<|sed -i|perl -i|\btee\b|python3? -|node -e|>\s*(?!\/dev\/)[\w.~\/-]/;
// A hunk counts as matched when at least this share of its non-blank added lines appear in an edit.
const MATCH_THRESHOLD = 0.8;
// Commits up to this long after the last transcript record still count as part of the session.
const COMMIT_GRACE_MS = 60 * 60 * 1000;

interface StructuredEdit {
  file: string;
  newText: string;
  hasReason: boolean;
  hasReasonSinceRequest: boolean;
}

interface Session {
  cwd?: string;
  start?: number;
  end?: number;
  structured: StructuredEdit[];
  bashWrites: string[];
  bashOther: number;
}

const totals = {
  transcripts: 0,
  badLines: 0,
  sessionsWithoutCwd: 0,
  sessionsWithEdits: 0,
  sessionsWithCommits: 0,
  structuredEdits: 0,
  structuredEditsWithReason: 0,
  structuredEditsWithReasonSinceRequest: 0,
  bashWrites: 0,
  bashOther: 0,
  sessionsWithoutGitUser: 0,
  commitsByOthers: 0,
  commits: 0,
  hunks: 0,
  lockfileHunks: 0,
  deletionOnlyHunks: 0,
  matchedStructured: 0,
  matchedBashOnly: 0,
  unmatched: 0,
  unmatchedUntouchedFile: 0,
  unmatchedNearMiss: 0,
  unmatchedTouchedFile: 0,
};

// An unmatched hunk at or above this coverage was probably the agent's edit, changed afterwards
// (for example by a formatter or a later hand edit).
const NEAR_MISS_THRESHOLD = 0.3;

/** Return the trimmed, non-blank lines of a text, which is how hunks and edits are compared. */
function lines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Read one transcript into the edits it made and the time range it covers. */
function readSession(file: string): Session {
  const session: Session = { structured: [], bashWrites: [], bashOther: 0 };
  let previousHadReason = false;
  // Tracks whether any assistant text or thinking appeared since the user's latest request, which
  // is the widest place an extension could look for an edit's explanation.
  let reasonSinceRequest = false;

  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(raw);
    } catch {
      totals.badLines++;
      continue;
    }

    session.cwd ??= record.cwd;
    const time = Date.parse(record.timestamp);
    if (!Number.isNaN(time)) {
      session.start = Math.min(session.start ?? time, time);
      session.end = Math.max(session.end ?? time, time);
    }

    const content = record.message?.content;

    // Tool results also arrive as user records; only a typed request starts a new explanation scope.
    if (record.type === "user") {
      const isRequest =
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.some((block: any) => block.type === "text") &&
          !content.some((block: any) => block.type === "tool_result"));
      if (isRequest) {
        reasonSinceRequest = false;
        previousHadReason = false;
      }
      continue;
    }
    if (record.type !== "assistant" || !Array.isArray(content)) continue;

    // Reasoning counts if the same assistant message, or the one just before it, has visible
    // text or non-empty thinking ahead of the edit.
    let hasReason = previousHadReason;
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) hasReason = true;
      if (block.type === "thinking" && block.thinking?.trim()) hasReason = true;
      if (hasReason) reasonSinceRequest = true;
      if (block.type !== "tool_use") continue;

      const input = block.input ?? {};
      const reasons = { hasReason, hasReasonSinceRequest: reasonSinceRequest };
      if (block.name === "Edit" && input.file_path) {
        session.structured.push({ file: input.file_path, newText: input.new_string ?? "", ...reasons });
      } else if (block.name === "MultiEdit" && input.file_path) {
        for (const edit of input.edits ?? []) {
          session.structured.push({ file: input.file_path, newText: edit.new_string ?? "", ...reasons });
        }
      } else if (block.name === "Write" && input.file_path) {
        session.structured.push({ file: input.file_path, newText: input.content ?? "", ...reasons });
      } else if (block.name === "Bash" && typeof input.command === "string") {
        if (BASH_WRITE.test(input.command)) session.bashWrites.push(input.command);
        else session.bashOther++;
      }
    }
    previousHadReason = content.some(
      (block: any) =>
        (block.type === "text" && block.text?.trim()) ||
        (block.type === "thinking" && block.thinking?.trim()),
    );
  }
  return session;
}

/** Run git in the session's repo and return stdout, or undefined when it is not a repo. */
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/** Split one commit's zero-context patch into hunks with their file and changed lines. */
function commitHunks(cwd: string, sha: string) {
  const patch = git(cwd, ["show", "--format=", "--unified=0", "--no-color", "--no-renames", sha]) ?? "";
  const hunks: { file: string; added: string[]; removed: string[] }[] = [];
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("@@")) hunks.push({ file, added: [], removed: [] });
    else if (line.startsWith("+") && hunks.length) hunks.at(-1)!.added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("--- ") && hunks.length) {
      hunks.at(-1)!.removed.push(line.slice(1));
    }
  }
  return hunks;
}

/** Return the share of `wanted` lines found in `available`. */
function coverage(wanted: string[], available: Set<string>) {
  return wanted.filter((line) => available.has(line)).length / wanted.length;
}

for (const project of readdirSync(projectsDir)) {
  const projectPath = path.join(projectsDir, project);
  if (!statSync(projectPath).isDirectory()) continue;

  for (const name of readdirSync(projectPath).filter((file) => file.endsWith(".jsonl"))) {
    totals.transcripts++;
    const session = readSession(path.join(projectPath, name));
    totals.structuredEdits += session.structured.length;
    totals.structuredEditsWithReason += session.structured.filter((edit) => edit.hasReason).length;
    totals.structuredEditsWithReasonSinceRequest += session.structured.filter(
      (edit) => edit.hasReasonSinceRequest,
    ).length;
    totals.bashWrites += session.bashWrites.length;
    totals.bashOther += session.bashOther;

    if (!session.structured.length && !session.bashWrites.length) continue;
    totals.sessionsWithEdits++;
    if (!session.cwd || session.start === undefined || session.end === undefined) {
      totals.sessionsWithoutCwd++;
      continue;
    }

    const since = new Date(session.start).toISOString();
    const until = new Date(session.end + COMMIT_GRACE_MS).toISOString();
    const email = git(session.cwd, ["config", "user.email"])?.trim();
    if (!email) {
      totals.sessionsWithoutGitUser++;
      continue;
    }

    // Each commit is listed with its author email so pulled upstream work can be set aside.
    const log = git(session.cwd, ["log", "--all", "--no-merges", `--since=${since}`, `--until=${until}`, "--format=%H %ae"]);
    const shas: string[] = [];
    for (const entry of (log ?? "").split("\n").filter(Boolean)) {
      const [sha, author] = entry.split(" ");
      if (author?.toLowerCase() === email.toLowerCase()) shas.push(sha!);
      else totals.commitsByOthers++;
    }
    if (!shas.length) continue;
    totals.sessionsWithCommits++;
    totals.commits += shas.length;

    const bashLines = new Set(session.bashWrites.flatMap(lines));
    for (const sha of shas) {
      for (const hunk of commitHunks(session.cwd, sha)) {
        totals.hunks++;
        if (LOCKFILES.test(hunk.file)) {
          totals.lockfileHunks++;
          continue;
        }
        const added = lines(hunk.added.join("\n"));
        if (!added.length) {
          totals.deletionOnlyHunks++;
          continue;
        }

        const fileEdits = session.structured.filter((edit) => edit.file.endsWith(`/${hunk.file}`));
        const structuredLines = new Set(fileEdits.flatMap((edit) => lines(edit.newText)));
        const structuredCoverage = coverage(added, structuredLines);
        const bashCoverage = coverage(added, bashLines);
        if (structuredCoverage >= MATCH_THRESHOLD) {
          totals.matchedStructured++;
          continue;
        }
        if (bashCoverage >= MATCH_THRESHOLD) {
          totals.matchedBashOnly++;
          continue;
        }

        // Separate hunks the agent never went near from agent edits the matcher missed.
        totals.unmatched++;
        const fileName = path.basename(hunk.file);
        const touched =
          fileEdits.length > 0 || session.bashWrites.some((command) => command.includes(fileName));
        if (!touched) totals.unmatchedUntouchedFile++;
        else if (Math.max(structuredCoverage, bashCoverage) >= NEAR_MISS_THRESHOLD) {
          totals.unmatchedNearMiss++;
        } else totals.unmatchedTouchedFile++;
      }
    }
  }
}

const scored = totals.matchedStructured + totals.matchedBashOnly + totals.unmatched;
const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "n/a");

console.log(JSON.stringify(totals, null, 2));
console.log(`
Hunks scored (excluding lockfiles and deletion-only): ${scored}
  matched to a file-edit tool call:        ${totals.matchedStructured} (${percent(totals.matchedStructured, scored)})
  matched only to a shell command:          ${totals.matchedBashOnly} (${percent(totals.matchedBashOnly, scored)})
  not matched:                              ${totals.unmatched} (${percent(totals.unmatched, scored)})
    file the agent never edited:            ${totals.unmatchedUntouchedFile}
    agent edited the file, lines changed:   ${totals.unmatchedNearMiss}
    agent edited the file, little overlap:  ${totals.unmatchedTouchedFile}
Commits by other authors set aside:         ${totals.commitsByOthers}
File-edit tool calls with reasoning nearby: ${percent(totals.structuredEditsWithReason, totals.structuredEdits)}
  ...or anywhere since the user's request:  ${percent(totals.structuredEditsWithReasonSinceRequest, totals.structuredEdits)}
Shell commands that look like file writes:  ${totals.bashWrites} of ${totals.bashWrites + totals.bashOther} shell commands`);
