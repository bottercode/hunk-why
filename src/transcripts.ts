/**
 * Reads Claude Code session transcripts into the edits the agent made inside one repository.
 *
 * Claude Code appends one JSON record per line to `<config>/projects/<encoded cwd>/<session>.jsonl`.
 * Each edit is either a file-edit tool call (Edit, MultiEdit, Write), whose new text is exact, or a
 * shell command that looks like it writes files, whose new text is somewhere inside the command.
 * Every edit carries the user's latest request and the agent's closest preceding explanation, which
 * is what the review note shows. The closest explanation wins whether it is visible text or
 * thinking: transcripts sometimes keep only thinking before an edit, and an older visible message
 * usually describes an earlier step. Records outside the repository are ignored, so the encoding of the
 * project directory name never decides which sessions count.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentEdit {
  sessionId: string;
  /** Milliseconds since the epoch, from the record that made the edit. */
  timestamp: number;
  kind: "tool" | "shell";
  /** Repository-relative path for tool edits; shell edits name files only inside `text`. */
  file?: string;
  /** New text for tool edits, or the full command for shell edits. */
  text: string;
  request?: string;
  reasoning?: string;
  /** Whether `reasoning` was said to the user or came from the agent's thinking. */
  reasoningSource?: "text" | "thinking";
}

// Shell commands that commonly write files: heredocs, in-place editors, tee, inline scripts, and
// redirects to anything other than /dev/*.
const SHELL_WRITE = /<<|sed -i|perl -i|\btee\b|python3? -|node -e|bun -e|>\s*(?!\/dev\/)[\w.~\/-]/;

/** Return the directory holding Claude Code project transcripts, honoring overrides. */
export function claudeProjectsDir(env: Record<string, string | undefined> = process.env) {
  if (env.HUNK_WHY_PROJECTS_DIR) return env.HUNK_WHY_PROJECTS_DIR;
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

/** List transcript files modified at or after `since` (milliseconds), newest first. */
export async function findRecentTranscripts(projectsDir: string, since: number) {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }

  const found: { file: string; modified: number }[] = [];
  for (const project of projects) {
    const projectDir = path.join(projectsDir, project);
    let names: string[];
    try {
      names = await readdir(projectDir);
    } catch {
      continue;
    }

    for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
      const file = path.join(projectDir, name);
      const modified = (await stat(file)).mtimeMs;
      if (modified >= since) found.push({ file, modified });
    }
  }
  return found.sort((a, b) => b.modified - a.modified).map((entry) => entry.file);
}

/** Return whether `target` is `root` or inside it. */
function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Return the typed request in a user record, or undefined for tool results and meta records. */
function requestText(record: any): string | undefined {
  if (record.isMeta) return undefined;
  const content = record.message?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && !content.some((block: any) => block?.type === "tool_result")) {
    text = content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
  }

  // Slash-command wrappers and hook output arrive as tagged text rather than typed requests.
  text = text?.trim();
  return text && !text.startsWith("<") ? text : undefined;
}

/** Parse one transcript into the edits it made inside `repoRoot`. */
export function parseTranscript(contents: string, sessionId: string, repoRoot: string) {
  const edits: AgentEdit[] = [];
  let request: string | undefined;
  // The closest explanation since the latest request, whichever kind of block it came from.
  let explanation: { text: string; source: "text" | "thinking" } | undefined;

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "user") {
      const typed = requestText(record);
      if (typed !== undefined) {
        request = typed;
        explanation = undefined;
      }
      continue;
    }

    const content = record.message?.content;
    if (record.type !== "assistant" || !Array.isArray(content)) continue;
    if (typeof record.cwd !== "string" || !isInside(repoRoot, record.cwd)) continue;
    const timestamp = Date.parse(record.timestamp) || 0;

    for (const block of content) {
      if (block?.type === "text" && block.text?.trim()) explanation = { text: block.text.trim(), source: "text" };
      if (block?.type === "thinking" && block.thinking?.trim()) {
        explanation = { text: block.thinking.trim(), source: "thinking" };
      }
      if (block?.type !== "tool_use") continue;

      const context = {
        sessionId,
        timestamp,
        request,
        reasoning: explanation?.text,
        reasoningSource: explanation?.source,
      };
      const input = block.input ?? {};
      const file =
        typeof input.file_path === "string" && isInside(repoRoot, path.resolve(record.cwd, input.file_path))
          ? path.relative(repoRoot, path.resolve(record.cwd, input.file_path)).split(path.sep).join("/")
          : undefined;

      if (block.name === "Edit" && file) {
        edits.push({ ...context, kind: "tool", file, text: String(input.new_string ?? "") });
      } else if (block.name === "MultiEdit" && file && Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          edits.push({ ...context, kind: "tool", file, text: String(edit?.new_string ?? "") });
        }
      } else if (block.name === "Write" && file) {
        edits.push({ ...context, kind: "tool", file, text: String(input.content ?? "") });
      } else if (block.name === "Bash" && typeof input.command === "string" && SHELL_WRITE.test(input.command)) {
        edits.push({ ...context, kind: "shell", text: input.command });
      }
    }
  }
  return edits;
}

/** Read every recent transcript and return the edits made inside `repoRoot`. */
export async function readAgentEdits(projectsDir: string, repoRoot: string, since: number) {
  const files = await findRecentTranscripts(projectsDir, since);
  const edits: AgentEdit[] = [];
  const sessions = new Set<string>();
  for (const file of files) {
    const sessionId = path.basename(file, ".jsonl");
    const parsed = parseTranscript(await readFile(file, "utf8"), sessionId, repoRoot);
    if (parsed.length) sessions.add(sessionId);
    edits.push(...parsed);
  }
  return { edits, sessionCount: sessions.size };
}
