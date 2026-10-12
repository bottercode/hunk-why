/**
 * Attributes each changed hunk to the agent edits that wrote it.
 *
 * Comparison ignores whitespace, quote style, and trailing `;`/`,` so formatter rewrites still
 * match. Shell commands are also searched after decoding escapes, because code a script embeds in
 * a string literal carries `\"` and similar escapes that no committed line contains. Only
 * significant lines count: a `}` or `return` appears in almost every edit and proves nothing.
 * A hunk is explained when up to three edits together cover enough of its significant lines;
 * newer edits win ties because a later edit is the one that left the code in its current shape.
 */

import path from "node:path";
import type { AgentEdit } from "./transcripts";
import type { ChangedHunk } from "./hunks";

export interface HunkAttribution {
  hunk: ChangedHunk;
  /** Edits that wrote the hunk, strongest first; empty when the hunk is unexplained. */
  edits: AgentEdit[];
  /** Share of the hunk's significant lines covered by `edits`. */
  coverage: number;
  /** False when the hunk has no significant lines to compare. */
  comparable: boolean;
}

// A normalized line shorter than this is too generic to identify an edit.
const MIN_SIGNIFICANT_LENGTH = 8;
// Share of significant lines that must be covered for a hunk to count as explained.
export const EXPLAINED_COVERAGE = 0.6;
const MAX_EDITS_PER_HUNK = 3;

/** Normalize code for comparison: drop whitespace and unify quote characters. */
export function normalize(text: string) {
  return text.replace(/\s+/g, "").replace(/['`]/g, '"');
}

/** Decode the escapes scripts use to embed code in strings, such as `\n` inside Python literals. */
export function decodeEscapes(text: string) {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'`\\])/g, "$1");
}

/** Return the normalized significant lines of a hunk, without trailing `;` or `,`. */
export function significantLines(added: string[]) {
  return added
    .map((line) => normalize(line).replace(/[;,]+$/, ""))
    .filter((line) => line.length >= MIN_SIGNIFICANT_LENGTH);
}

interface Candidate {
  edit: AgentEdit;
  haystack: string;
}

/** Prepare one edit's searchable text once, rather than per hunk line. */
function toCandidate(edit: AgentEdit): Candidate {
  const raw = normalize(edit.text);
  return { edit, haystack: edit.kind === "shell" ? `${raw}\u0000${normalize(decodeEscapes(edit.text))}` : raw };
}

/** Return whether a shell command plausibly writes `file`, judged by its path or file name. */
function shellMentions(command: string, file: string) {
  return command.includes(file) || command.includes(path.posix.basename(file));
}

/** Attribute every hunk to the smallest set of edits that covers it. */
export function attributeHunks(hunks: ChangedHunk[], edits: AgentEdit[]): HunkAttribution[] {
  const candidates = edits.map(toCandidate);

  return hunks.map((hunk) => {
    const lines = significantLines(hunk.added);
    if (!lines.length) return { hunk, edits: [], coverage: 0, comparable: false };

    const relevant = candidates.filter(({ edit }) =>
      edit.kind === "tool" ? edit.file === hunk.file : shellMentions(edit.text, hunk.file),
    );
    const uncovered = new Set(lines.keys());
    const chosen: AgentEdit[] = [];

    // Greedy cover: repeatedly take the edit that explains the most still-uncovered lines.
    while (chosen.length < MAX_EDITS_PER_HUNK && uncovered.size) {
      let best: { candidate: Candidate; covers: number[] } | undefined;
      for (const candidate of relevant) {
        if (chosen.includes(candidate.edit)) continue;
        const covers = [...uncovered].filter((index) => candidate.haystack.includes(lines[index]!));
        const better =
          !best ||
          covers.length > best.covers.length ||
          (covers.length === best.covers.length && candidate.edit.timestamp > best.candidate.edit.timestamp);
        if (covers.length && better) best = { candidate, covers };
      }
      if (!best) break;
      chosen.push(best.candidate.edit);
      for (const index of best.covers) uncovered.delete(index);
    }

    const coverage = (lines.length - uncovered.size) / lines.length;
    return { hunk, edits: coverage >= EXPLAINED_COVERAGE ? chosen : [], coverage, comparable: true };
  });
}
