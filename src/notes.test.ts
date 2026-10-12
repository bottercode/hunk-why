import { describe, expect, test } from "bun:test";
import type { HunkAttribution } from "./match";
import { buildAgentContext, truncate } from "./notes";
import type { AgentEdit } from "./transcripts";

/** Build one attribution for a three-line hunk at line 5 of `file`. */
function createTestAttribution(
  edits: Partial<AgentEdit>[],
  coverage = 1,
  file = "src/api.ts",
): HunkAttribution {
  return {
    hunk: { file, newStart: 5, added: ["a", "b", "c"] },
    edits: edits.map((edit) => ({ sessionId: "abcdef123456", timestamp: 0, kind: "tool", text: "", ...edit })),
    coverage,
    comparable: true,
  };
}

describe("buildAgentContext", () => {
  test("anchors one note per explained hunk to its working-tree lines", () => {
    const context = buildAgentContext(
      [createTestAttribution([{ request: "Add a retry", reasoning: "Timeouts are transient, so retry." }])],
      1,
    );
    const [note] = context.files[0]!.annotations;

    expect(context.files[0]!.path).toBe("src/api.ts");
    expect(note).toMatchObject({
      newRange: [5, 7],
      summary: "Timeouts are transient, so retry.",
      confidence: "high",
      author: "claude-code",
      source: "hunk-why",
    });
    expect(note!.rationale).toContain('You asked: "Add a retry"');
    expect(note!.rationale).toContain("Matched 100% of changed lines to a file-edit tool call · session abcdef12");
  });

  test("adds no note for unexplained hunks and reports coverage honestly", () => {
    const context = buildAgentContext(
      [createTestAttribution([{ reasoning: "why" }]), createTestAttribution([], 0.2, "src/other.ts")],
      2,
    );

    expect(context.files.map((file) => file.path)).toEqual(["src/api.ts"]);
    expect(context.summary).toBe("hunk-why explained 1 of 2 changed hunks from 2 Claude Code session(s).");
  });

  test("grades confidence by evidence: shell matches and partial coverage rank lower", () => {
    const grade = (edit: Partial<AgentEdit>, coverage: number) =>
      buildAgentContext([createTestAttribution([edit], coverage)], 1).files[0]!.annotations[0]!.confidence;

    expect(grade({ kind: "tool" }, 0.95)).toBe("high");
    expect(grade({ kind: "shell" }, 0.95)).toBe("medium");
    expect(grade({ kind: "tool" }, 0.85)).toBe("medium");
    expect(grade({ kind: "tool" }, 0.65)).toBe("low");
  });

  test("falls back to the request when the agent gave no explanation", () => {
    const context = buildAgentContext([createTestAttribution([{ request: "Add a retry" }])], 1);

    expect(context.files[0]!.annotations[0]!.summary).toBe('Written for: "Add a retry"');
  });
});

describe("truncate", () => {
  test("flattens whitespace and cuts on a word boundary", () => {
    expect(truncate("one two\nthree four five", 14)).toBe("one two three…");
    expect(truncate("short", 14)).toBe("short");
  });
});
