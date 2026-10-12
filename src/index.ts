/**
 * Registers `hunk why`, which opens the working-tree review with a note on each hunk explaining
 * why Claude Code wrote it.
 *
 * The command reads only transcripts modified since the last commit, matches their edits to the
 * current hunks, writes Hunk's agent-context sidecar into a private temporary directory, and
 * delegates to the built-in `hunk diff`. Hunk owns all rendering and note placement; this
 * extension only supplies the notes. Transcript text never leaves the machine, and the sidecar is
 * deleted when the extension shuts down. `--json` prints the sidecar instead of opening a review.
 */

import { rmSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HunkExtensionUserError, type HunkExtensionAPI } from "hunkdiff/extension";
import { git, readWorkingTreeHunks } from "./hunks";
import { attributeHunks } from "./match";
import { buildAgentContext, countCoverage, type AgentContext } from "./notes";
import { claudeProjectsDir, readAgentEdits } from "./transcripts";

const USAGE = "[--json]";

/** Build the agent-context sidecar for the repository containing `cwd`. */
export async function explainWorkingTree(cwd: string, projectsDir: string, signal?: AbortSignal) {
  const repoRoot = await git(cwd, ["rev-parse", "--show-toplevel"], signal).then(
    (stdout) => stdout.trim(),
    () => {
      throw new HunkExtensionUserError("hunk why needs to run inside a Git repository.");
    },
  );

  const { hunks, headTime } = await readWorkingTreeHunks(repoRoot, signal);
  // Edits recorded before the last commit are already committed, so older transcripts are skipped.
  const { edits, sessionCount } = await readAgentEdits(projectsDir, repoRoot, headTime);
  const attributions = attributeHunks(hunks, edits);
  return { context: buildAgentContext(attributions, sessionCount), ...countCoverage(attributions), sessionCount };
}

/** Write the sidecar into a fresh owner-only directory and return its path. */
async function writePrivateSidecar(context: AgentContext, directories: Set<string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hunk-why-"));
  directories.add(directory);
  await chmod(directory, 0o700);
  const file = path.join(directory, "agent-context.json");
  await writeFile(file, JSON.stringify(context), { flag: "wx", mode: 0o600 });
  return file;
}

export default function hunkWhy(hunk: HunkExtensionAPI) {
  const directories = new Set<string>();

  hunk.registerCliCommand(
    { name: "why", summary: "Review changes with the reasons from your Claude Code sessions", usage: USAGE },
    async (args, ctx) => {
      if (args.includes("--help") || args.includes("-h")) {
        await ctx.stdout.write(
          `Usage: hunk why ${USAGE}\n\n` +
            "Opens the working-tree review with a note on each hunk explaining why Claude Code\n" +
            "wrote it, read from your local Claude Code transcripts.\n\n" +
            "  --json   print Hunk's agent-context JSON instead of opening the review\n",
        );
        return { kind: "exit" };
      }
      const unknown = args.filter((arg) => arg !== "--json");
      if (unknown.length) {
        throw new HunkExtensionUserError(`Unknown argument: ${unknown[0]}`, {
          suggestions: [`Usage: hunk why ${USAGE}`],
        });
      }

      const result = await explainWorkingTree(ctx.cwd, claudeProjectsDir(), ctx.signal);
      if (args.includes("--json")) {
        await ctx.stdout.write(`${JSON.stringify(result.context, null, 2)}\n`);
        return { kind: "exit" };
      }

      await ctx.stderr.write(`${result.context.summary}\n`);
      const sidecar = await writePrivateSidecar(result.context, directories);
      // Notes are the point of this command, so show them even if the user's default hides them.
      return { kind: "delegate", argv: ["diff", "--agent-context", sidecar, "--agent-notes"] };
    },
  );

  hunk.on("shutdown", () => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.clear();
  });
}
