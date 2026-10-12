import { describe, expect, test } from "bun:test";
import { claudeProjectsDir, parseTranscript } from "./transcripts";

const REPO = "/work/repo";
const TIME = "2026-10-12T10:00:00.000Z";

/** Serialize transcript records the way Claude Code writes them: one JSON object per line. */
function createTestTranscript(records: unknown[]) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

/** Build a typed user request record. */
function testRequest(text: string) {
  return { type: "user", cwd: REPO, timestamp: TIME, message: { role: "user", content: text } };
}

/** Build an assistant record with the given content blocks. */
function testAssistant(content: unknown[], cwd = REPO) {
  return { type: "assistant", cwd, timestamp: TIME, message: { content } };
}

/** Build an Edit tool call for `file`. */
function testEdit(file: string, newText: string) {
  return { type: "tool_use", name: "Edit", input: { file_path: file, old_string: "x", new_string: newText } };
}

describe("parseTranscript", () => {
  test("records an edit with its request and the closest explanation", () => {
    const transcript = createTestTranscript([
      testRequest("Add a retry"),
      testAssistant([{ type: "text", text: "Timeouts are transient, so retry." }, testEdit(`${REPO}/src/api.ts`, "retry()")]),
    ]);

    expect(parseTranscript(transcript, "s1", REPO)).toEqual([
      {
        sessionId: "s1",
        timestamp: Date.parse(TIME),
        kind: "tool",
        file: "src/api.ts",
        text: "retry()",
        request: "Add a retry",
        reasoning: "Timeouts are transient, so retry.",
      },
    ]);
  });

  test("keeps the explanation across tool results but resets it on a new request", () => {
    const transcript = createTestTranscript([
      testRequest("first"),
      testAssistant([{ type: "text", text: "Plan for first." }]),
      { type: "user", cwd: REPO, timestamp: TIME, message: { content: [{ type: "tool_result", content: "ok" }] } },
      testAssistant([testEdit(`${REPO}/a.ts`, "one()")]),
      testRequest("second"),
      testAssistant([testEdit(`${REPO}/b.ts`, "two()")]),
    ]);
    const [first, second] = parseTranscript(transcript, "s1", REPO);

    expect(first).toMatchObject({ request: "first", reasoning: "Plan for first." });
    expect(second).toMatchObject({ request: "second", reasoning: undefined });
  });

  test("prefers visible text over thinking and falls back to thinking", () => {
    const transcript = createTestTranscript([
      testRequest("go"),
      testAssistant([{ type: "thinking", thinking: "private plan" }, testEdit(`${REPO}/a.ts`, "one()")]),
      testAssistant([{ type: "text", text: "Visible plan." }, testEdit(`${REPO}/b.ts`, "two()")]),
    ]);
    const [first, second] = parseTranscript(transcript, "s1", REPO);

    expect(first!.reasoning).toBe("private plan");
    expect(second!.reasoning).toBe("Visible plan.");
  });

  test("ignores meta records and tagged command output as requests", () => {
    const transcript = createTestTranscript([
      testRequest("real request"),
      { ...testRequest("injected reminder"), isMeta: true },
      testRequest("<command-name>/clear</command-name>"),
      testAssistant([testEdit(`${REPO}/a.ts`, "one()")]),
    ]);

    expect(parseTranscript(transcript, "s1", REPO)[0]!.request).toBe("real request");
  });

  test("drops edits made outside the repository", () => {
    const transcript = createTestTranscript([
      testAssistant([testEdit("/elsewhere/a.ts", "one()")]),
      testAssistant([testEdit(`${REPO}/a.ts`, "two()")], "/elsewhere"),
      testAssistant([testEdit(`${REPO}-sibling/a.ts`, "three()")]),
    ]);

    expect(parseTranscript(transcript, "s1", REPO)).toEqual([]);
  });

  test("expands MultiEdit, records Write, and keeps only shell commands that write files", () => {
    const transcript = createTestTranscript([
      testAssistant([
        { type: "tool_use", name: "MultiEdit", input: { file_path: `${REPO}/a.ts`, edits: [{ new_string: "one()" }, { new_string: "two()" }] } },
        { type: "tool_use", name: "Write", input: { file_path: "src/new.ts", content: "three()" } },
        { type: "tool_use", name: "Bash", input: { command: "cat > b.ts <<EOF\nfour()\nEOF" } },
        { type: "tool_use", name: "Bash", input: { command: "git status" } },
      ]),
    ]);
    const edits = parseTranscript(transcript, "s1", REPO);

    expect(edits.map((edit) => [edit.kind, edit.file, edit.text])).toEqual([
      ["tool", "a.ts", "one()"],
      ["tool", "a.ts", "two()"],
      ["tool", "src/new.ts", "three()"],
      ["shell", undefined, "cat > b.ts <<EOF\nfour()\nEOF"],
    ]);
  });

  test("skips malformed lines instead of failing the whole transcript", () => {
    const transcript = `not json\n${JSON.stringify(testAssistant([testEdit(`${REPO}/a.ts`, "one()")]))}`;

    expect(parseTranscript(transcript, "s1", REPO)).toHaveLength(1);
  });
});

describe("claudeProjectsDir", () => {
  test("honors the explicit override, then CLAUDE_CONFIG_DIR", () => {
    expect(claudeProjectsDir({ HUNK_WHY_PROJECTS_DIR: "/x" })).toBe("/x");
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/projects");
  });
});
