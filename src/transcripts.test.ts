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
        reasoningSource: "text",
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

  test("uses the explanation closest to each edit, whether visible text or thinking", () => {
    const transcript = createTestTranscript([
      testRequest("go"),
      testAssistant([{ type: "thinking", thinking: "private plan" }, testEdit(`${REPO}/a.ts`, "one()")]),
      testAssistant([{ type: "text", text: "Visible plan." }, testEdit(`${REPO}/b.ts`, "two()")]),
    ]);
    const [first, second] = parseTranscript(transcript, "s1", REPO);

    expect(first).toMatchObject({ reasoning: "private plan", reasoningSource: "thinking" });
    expect(second).toMatchObject({ reasoning: "Visible plan.", reasoningSource: "text" });
  });

  test("prefers fresh thinking over an older reply when the transcript kept no text before the edit", () => {
    // Mirrors a real session: the reply before a Read, then only thinking before the Edit, with
    // attachment and file-history records interleaved.
    const transcript = createTestTranscript([
      testRequest("lets say i want to test here only"),
      { type: "attachment", cwd: REPO, timestamp: TIME },
      { type: "file-history-snapshot" },
      testAssistant([{ type: "thinking", thinking: "Plan the whole test." }]),
      testAssistant([{ type: "text", text: "Yes, this session works too." }]),
      testAssistant([{ type: "tool_use", name: "Read", input: { file_path: `${REPO}/a.ts` } }]),
      { type: "user", cwd: REPO, timestamp: TIME, message: { content: [{ type: "tool_result", content: "file" }] } },
      { type: "attachment", cwd: REPO, timestamp: TIME },
      testAssistant([{ type: "thinking", thinking: "Add a path helper to a.ts." }]),
      testAssistant([testEdit(`${REPO}/a.ts`, "helper()")]),
    ]);

    expect(parseTranscript(transcript, "s1", REPO)[0]).toMatchObject({
      request: "lets say i want to test here only",
      reasoning: "Add a path helper to a.ts.",
      reasoningSource: "thinking",
    });
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
