#!/usr/bin/env bun

/**
 * Prints the record layout of one Claude Code transcript from a given request onward, for
 * debugging which explanation hunk-why attaches to an edit. Each line shows the record's position,
 * type, short uuid/parent ids, and its blocks, with text cut to 50 characters.
 *
 * Usage: bun scripts/inspect-session.ts <transcript.jsonl> "<words from the starting request>"
 *        bun scripts/inspect-session.ts --latest "<words>"   (newest transcript for this folder)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { claudeProjectsDir } from "../src/transcripts";

const [target, needle = ""] = process.argv.slice(2);
if (!target) {
  console.error('Usage: bun scripts/inspect-session.ts <transcript.jsonl|--latest> "<request words>"');
  process.exit(1);
}

/** Return the newest transcript in the project folder Claude Code uses for the current directory. */
function latestTranscript() {
  const dir = path.join(claudeProjectsDir(), process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dir, name));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}

const file = target === "--latest" ? latestTranscript() : target;
const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 8) : "-");
const clip = (text: string) => JSON.stringify(text.replace(/\s+/g, " ").slice(0, 50));
let started = !needle;

readFileSync(file, "utf8")
  .split("\n")
  .forEach((line, index) => {
    if (!line.trim()) return;
    const record = JSON.parse(line);
    const content = record.message?.content;
    const blocks =
      typeof content === "string"
        ? [`text:${clip(content)}`]
        : Array.isArray(content)
          ? content.map((block: any) =>
              block.type === "text"
                ? `text:${clip(block.text ?? "")}`
                : block.type === "thinking"
                  ? `thinking(${(block.thinking ?? "").length} chars)`
                  : block.type === "tool_use"
                    ? `tool_use:${block.name}`
                    : block.type,
            )
          : [];

    if (!started && blocks.some((block) => block.includes(needle))) started = true;
    if (!started) return;
    const flags = [record.isMeta && "meta", record.isSidechain && "sidechain"].filter(Boolean).join(",");
    console.log(
      `${String(index + 1).padStart(5)} ${String(record.type).padEnd(10)} uuid=${short(record.uuid)} parent=${short(record.parentUuid)} msg=${short(record.message?.id)} ${flags} ${blocks.join(" | ")}`,
    );
  });
