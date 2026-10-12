# hunk-why

See **why** your coding agent made each change, right beside the code.

`hunk why` opens your working-tree review in [Hunk](https://hunk.dev) with a note on each hunk explaining why Claude Code wrote it: your request, and the agent's own reasoning at the moment it made the edit. Everything comes from the session transcripts Claude Code already saves on your machine. The agent doesn't have to write notes, and it works after the session has ended.

```text
  2 +  for (let attempt = 1; attempt <= 3; attempt++) {
     ┌─ claude-code ──────────────────────────────────────────────────────┐
     │ The CI failures are network timeouts. I'll retry up to 3 times     │
     │ with a short delay, but not on 404, since a missing user won't…    │
     │                                                                    │
     │ You asked: "fetchUser fails randomly in CI. Add a retry."          │
     │ Matched 100% of changed lines to a file-edit tool call · session … │
     └────────────────────────────────────────────────────────────────────┘
  3 +    try {
```

## Install

Requires Hunk 0.21 or newer (tested with 0.23) and [Bun](https://bun.sh).

```sh
hunk extension install bottercode/hunk-why
```

## Use

After a Claude Code session, in the same repository:

```sh
hunk why          # open the review with a note on each hunk the agent wrote
hunk why --json   # print the notes as Hunk agent-context JSON instead
```

Press `a` in Hunk to hide or show the notes. Each note carries a confidence level:

- **high**: a file-edit tool call wrote at least 90% of the hunk's lines exactly as they are now.
- **medium**: the lines came from a shell command (a heredoc or a script), or 80% or more matched.
- **low**: at least 60% of the lines matched, so part of the hunk changed after the agent wrote it.

Hunks it can't trace get **no note**. Inventing a reason would be worse than showing none. The summary line reports how many hunks were explained.

## How it works

1. **Collect the diff:** read the working tree against `HEAD`, including untracked files, which is what `hunk diff` reviews.
2. **Read recent transcripts:** read Claude Code transcripts modified since your last commit (`~/.claude/projects/*/*.jsonl`), keeping only records from inside this repository.
3. **Gather edits:** collect each edit the agent made, both file-edit tool calls (Edit, MultiEdit, Write) and shell commands that write files. Each one keeps your latest request and the agent's closest explanation before the edit.
4. **Match:** attribute each hunk to the edits that wrote it. Comparison ignores whitespace, quote style and trailing `;`/`,` so formatter rewrites still match. Shell commands are also searched with escapes decoded, so code a script embedded in a string is found. Generic lines like `}` don't count as evidence.
5. **Open the review:** write Hunk's `--agent-context` notes file and open `hunk diff` with notes shown.

## Privacy

- hunk-why reads transcripts locally and makes **no network requests**.
- The notes file is written to a private temporary directory (owner-only permissions) and deleted when Hunk exits.
- Notes quote your prompts and the agent's reasoning, so check what's on screen before sharing a screenshot.

## How well does it work?

Before building this, I measured whether matching works on my own Claude Code history: 14 sessions, 77 commits, about 1,000 hunks in files the agent edited. A tool-edit-only matcher explained about 60% of them, and roughly 72% once formatter rewrites are tolerated. That's one person's history, so treat it as a rough number. [`scripts/feasibility.ts`](scripts/feasibility.ts) measures your own history and prints only counts:

```sh
bun scripts/feasibility.ts
```

## Limitations

- **Claude Code only** for now. Other agents store transcripts differently. A reader for another agent's format would be welcome.
- **Working tree only:** it explains uncommitted changes against `HEAD`, not past commits.
- **Shell-written files must be named:** a shell command can only explain a file whose path or name appears in the command.
- **Edits are only explained where the reasoning was written:** the note shows the agent's closest explanation before the edit, which is usually, but not always, the reason for that specific change.

## Configuration

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude Code config directory; transcripts are read from its `projects/` folder |
| `HUNK_WHY_PROJECTS_DIR` | Read transcripts from this folder instead |

## Development

```sh
bun install
bun test
bun run typecheck
hunk --extension . why        # run your checkout without installing it
```

## License

[MIT](LICENSE)
