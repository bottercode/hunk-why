/**
 * Builds Hunk's `--agent-context` sidecar from hunk attributions.
 *
 * Each explained hunk gets one note anchored to its working-tree lines. The summary is the start
 * of the agent's own explanation, so the note card reads as "what and why" at a glance; the rationale
 * carries the user's request, the fuller explanation, and how the match was made, so a reviewer
 * can judge how much to trust it. Unexplained hunks get no note: inventing a reason would be worse
 * than showing none, and the top-level summary reports the coverage honestly.
 */

import type { AgentAnnotation } from "hunkdiff/extension";
import type { HunkAttribution } from "./match";

export interface AgentContextFile {
  path: string;
  annotations: AgentAnnotation[];
}

export interface AgentContext {
  version: 1;
  summary: string;
  files: AgentContextFile[];
}

const SUMMARY_LIMIT = 160;
const REQUEST_LIMIT = 300;
const REASONING_LIMIT = 700;

/** Collapse whitespace and cut text to `limit` characters on a word boundary. */
export function truncate(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > limit / 2 ? cut.slice(0, boundary) : cut}…`;
}

/** Return the start of the agent's explanation, the note's headline; the reason often follows the first sentence. */
function headline(reasoning: string | undefined, request: string | undefined) {
  if (reasoning) return truncate(reasoning, SUMMARY_LIMIT);
  if (request) return truncate(`Written for: "${request}"`, SUMMARY_LIMIT);
  return "Written by Claude Code (no explanation found in the session)";
}

/** Grade a match: exact tool edits that cover nearly everything are the strongest evidence. */
function confidence(attribution: HunkAttribution): AgentAnnotation["confidence"] {
  const primary = attribution.edits[0]!;
  if (attribution.coverage >= 0.9) return primary.kind === "tool" ? "high" : "medium";
  return attribution.coverage >= 0.8 ? "medium" : "low";
}

/** Build one note for an explained hunk. */
function toAnnotation(attribution: HunkAttribution): AgentAnnotation {
  const { hunk, edits, coverage } = attribution;
  const primary = edits[0]!;
  const lines: string[] = [];

  if (primary.request) lines.push(`You asked: "${truncate(primary.request, REQUEST_LIMIT)}"`);
  // The headline already shows a short explanation in full; repeat it only when it was cut off.
  const summary = headline(primary.reasoning, primary.request);
  if (primary.reasoning && summary !== truncate(primary.reasoning, REASONING_LIMIT)) {
    lines.push(`Agent: ${truncate(primary.reasoning, REASONING_LIMIT)}`);
  }
  // Thinking is the agent's internal reasoning, not something it told the user, so say so.
  if (primary.reasoningSource === "thinking") lines.push("From the agent's thinking, not its reply.");

  const how = primary.kind === "tool" ? "a file-edit tool call" : "a shell command";
  const extra = edits.length > 1 ? ` and ${edits.length - 1} later edit(s)` : "";
  const when = primary.timestamp ? new Date(primary.timestamp).toLocaleString() : "unknown time";
  lines.push(
    `Matched ${Math.round(coverage * 100)}% of changed lines to ${how}${extra} · session ${primary.sessionId.slice(0, 8)} · ${when}`,
  );

  return {
    newRange: [hunk.newStart, hunk.newStart + hunk.added.length - 1],
    summary,
    rationale: lines.join("\n\n"),
    confidence: confidence(attribution),
    author: "claude-code",
    source: "hunk-why",
    ...(primary.timestamp ? { createdAt: new Date(primary.timestamp).toISOString() } : {}),
  };
}

/** Group explained hunks into the sidecar file and summarize coverage. */
export function buildAgentContext(attributions: HunkAttribution[], sessionCount: number): AgentContext {
  const byFile = new Map<string, AgentAnnotation[]>();
  for (const attribution of attributions) {
    if (!attribution.edits.length) continue;
    const annotations = byFile.get(attribution.hunk.file) ?? [];
    annotations.push(toAnnotation(attribution));
    byFile.set(attribution.hunk.file, annotations);
  }

  const { explained, comparable } = countCoverage(attributions);
  return {
    version: 1,
    summary: `hunk-why explained ${explained} of ${comparable} changed hunks from ${sessionCount} Claude Code session(s).`,
    files: [...byFile].map(([path, annotations]) => ({ path, annotations })),
  };
}

/** Count explained hunks among those with enough content to compare. */
export function countCoverage(attributions: HunkAttribution[]) {
  return {
    explained: attributions.filter((attribution) => attribution.edits.length).length,
    comparable: attributions.filter((attribution) => attribution.comparable).length,
  };
}
