import { describe, expect, test } from "bun:test";
import type { ChangedHunk } from "./hunks";
import { attributeHunks, decodeEscapes, normalize, significantLines } from "./match";
import type { AgentEdit } from "./transcripts";

/** Build one agent edit with defaults for fields a test does not care about. */
function createTestEdit(overrides: Partial<AgentEdit> & Pick<AgentEdit, "text">): AgentEdit {
  return { sessionId: "session-a", timestamp: 1, kind: "tool", file: "src/api.ts", ...overrides };
}

/** Build one hunk in `src/api.ts` starting at line 10. */
function createTestHunk(added: string[], file = "src/api.ts"): ChangedHunk {
  return { file, newStart: 10, added };
}

describe("normalization", () => {
  test("ignores whitespace and quote style", () => {
    expect(normalize("const a = 'x';")).toBe(normalize('const  a="x";'));
  });

  test("decodes escapes used to embed code in scripts", () => {
    expect(decodeEscapes(String.raw`a\nb\t\"c\"`)).toBe('a\nb\t"c"');
  });

  test("drops generic lines that cannot identify an edit", () => {
    expect(significantLines(["}", "  return;", "", "const retries = 3;"])).toEqual(["constretries=3"]);
  });
});

describe("attributeHunks", () => {
  test("explains a hunk written by a file-edit tool call", () => {
    const edit = createTestEdit({ text: "const retries = 3;\nawait sleep(retries * 200);" });
    const [result] = attributeHunks([createTestHunk(["const retries = 3;", "await sleep(retries * 200);"])], [edit]);

    expect(result!.edits).toEqual([edit]);
    expect(result!.coverage).toBe(1);
  });

  test("still matches after a formatter changes spacing, quotes, and trailing commas", () => {
    const edit = createTestEdit({ text: "callService('users',retries)\nconst label=\"retry\"" });
    const [result] = attributeHunks(
      [createTestHunk(['  callService("users", retries),', "  const label = 'retry';"])],
      [edit],
    );

    expect(result!.edits).toEqual([edit]);
  });

  test("finds code a script embedded as an escaped string", () => {
    const edit = createTestEdit({
      kind: "shell",
      file: undefined,
      text:
        String.raw`python3 - <<'PY'` +
        "\n" +
        String.raw`open("src/api.ts","w").write("const label = \"retry\";\nlog(\"retrying request\");\n")`,
    });
    const [result] = attributeHunks(
      [createTestHunk(['const label = "retry";', 'log("retrying request");'])],
      [edit],
    );

    expect(result!.edits).toEqual([edit]);
  });

  test("ignores shell commands that never mention the hunk's file", () => {
    const edit = createTestEdit({ kind: "shell", file: undefined, text: "cat > other.ts <<EOF\nconst retries = 3;\nEOF" });
    const [result] = attributeHunks([createTestHunk(["const retries = 3;"])], [edit]);

    expect(result!.edits).toEqual([]);
  });

  test("ignores tool edits to a different file", () => {
    const edit = createTestEdit({ file: "src/other.ts", text: "const retries = 3;" });
    const [result] = attributeHunks([createTestHunk(["const retries = 3;"])], [edit]);

    expect(result!.edits).toEqual([]);
  });

  test("leaves hand-written hunks unexplained instead of guessing", () => {
    const edit = createTestEdit({ text: "const retries = 3;" });
    const [result] = attributeHunks(
      [createTestHunk(["const retries = 3;", "handWrittenTweak();", "anotherHandEdit();"])],
      [edit],
    );

    expect(result!.coverage).toBeCloseTo(1 / 3);
    expect(result!.edits).toEqual([]);
  });

  test("combines edits when no single edit wrote the whole hunk", () => {
    const first = createTestEdit({ text: "const retries = 3;", timestamp: 1 });
    const second = createTestEdit({ text: "await sleep(retries * 200);", timestamp: 2 });
    const [result] = attributeHunks(
      [createTestHunk(["const retries = 3;", "await sleep(retries * 200);"])],
      [first, second],
    );

    expect(result!.edits).toHaveLength(2);
    expect(result!.coverage).toBe(1);
  });

  test("prefers the newer of two edits that wrote the same lines", () => {
    const older = createTestEdit({ text: "const retries = 3;", timestamp: 1, sessionId: "old" });
    const newer = createTestEdit({ text: "const retries = 3;", timestamp: 2, sessionId: "new" });
    const [result] = attributeHunks([createTestHunk(["const retries = 3;"])], [older, newer]);

    expect(result!.edits[0]!.sessionId).toBe("new");
  });

  test("marks hunks with only generic lines as not comparable", () => {
    const [result] = attributeHunks([createTestHunk(["}", ""])], [createTestEdit({ text: "}" })]);

    expect(result!.comparable).toBe(false);
    expect(result!.edits).toEqual([]);
  });
});
