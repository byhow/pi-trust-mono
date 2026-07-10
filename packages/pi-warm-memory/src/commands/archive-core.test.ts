import { describe, expect, test } from "vitest";
import type { GitContext } from "../git-context.ts";
import {
  type ArchivePromptInput,
  buildArchivePrompt,
  INDEX_HEADER,
  parseArchiveArgs,
  TEMPLATE_FILE,
} from "./archive-core.ts";

/* ---------------------------------------------------------------------------
 * parseArchiveArgs — pure arg splitting
 * ------------------------------------------------------------------------- */
describe("parseArchiveArgs", () => {
  test("defaults to handoff and joins the whole arg list as the instruction", () => {
    const { packetKind, instruction } = parseArchiveArgs([
      "ship",
      "the",
      "feature",
    ]);
    expect(packetKind).toBe("handoff");
    expect(instruction).toBe("ship the feature");
  });

  test("treats a leading 'checkpoint' as the kind and drops it from the instruction", () => {
    const { packetKind, instruction } = parseArchiveArgs([
      "checkpoint",
      "before",
      "refactor",
    ]);
    expect(packetKind).toBe("checkpoint");
    expect(instruction).toBe("before refactor");
  });

  test("trims whitespace from the instruction", () => {
    const { instruction } = parseArchiveArgs(["  tidy   up  "]);
    expect(instruction).toBe("tidy   up");
  });

  test("yields an empty instruction when given none", () => {
    expect(parseArchiveArgs([])).toEqual({
      packetKind: "handoff",
      instruction: "",
    });
  });
});

/* ---------------------------------------------------------------------------
 * buildArchivePrompt — pure prompt assembly
 * ------------------------------------------------------------------------- */
const cwd = "/repo";
const historyDir = "/repo/.pi/history";
const timestamp = "2026-07-09T12:34:56.789Z";

const fullGit: GitContext = {
  repoName: "pi-trust-mono",
  branch: "main",
  shortSha: "abc1234",
  filesTouched: ["src/a.ts", "README.md"],
};

const baseInput = (
  over: Partial<ArchivePromptInput> = {},
): ArchivePromptInput => ({
  packetKind: "handoff",
  instruction: "Hand off the warm-memory work",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd,
  historyDir,
  timestamp,
  git: fullGit,
  template: "# Handoff\n\n- Goal:\n- State:\n- Next:",
  needsHeader: false,
  ...over,
});

describe("buildArchivePrompt", () => {
  test("renders the packet kind, instruction, template and session context", () => {
    const out = buildArchivePrompt(baseInput());
    expect(out).toContain("**handoff**");
    expect(out).toContain("Hand off the warm-memory work");
    expect(out).toContain("# Handoff");
    expect(out).toContain("- Thread ID: 11111111-2222-3333-4444-555555555555");
    expect(out).toContain("- Timestamp: 2026-07-09T12:34:56.789Z");
  });

  test("computes CWD-relative write paths from historyDir + timestamp", () => {
    const out = buildArchivePrompt(baseInput());
    // packets/2026/07 derived from the timestamp
    expect(out).toContain(".pi/history/packets/2026/07/");
    expect(out).toContain(
      "`2026-07-09T12-34-56.789Z-handoff-<slugified-topic>.md`",
    );
    expect(out).toContain("packets/2026/07/");
  });

  test("includes branch, commit and files-touched when git provides them", () => {
    const out = buildArchivePrompt(baseInput());
    expect(out).toContain("- Repo: pi-trust-mono");
    expect(out).toContain("- Branch: main");
    expect(out).toContain("- Commit: abc1234");
    expect(out).toContain("- CWD: /repo");
    expect(out).toContain("- Files touched:");
    expect(out).toContain("  - src/a.ts");
    expect(out).toContain("  - README.md");
  });

  test("omits branch/commit/files when git has only a repoName", () => {
    const out = buildArchivePrompt(
      baseInput({ git: { repoName: "my-app", filesTouched: [] } }),
    );
    expect(out).toContain("- Repo: my-app");
    expect(out).not.toContain("- Branch:");
    expect(out).not.toContain("- Commit:");
    expect(out).not.toContain("- Files touched:");
  });

  test("emits the header-creation step on a fresh project (needsHeader true)", () => {
    const out = buildArchivePrompt(baseInput({ needsHeader: true }));
    expect(out).toContain("Create `.pi/history/index.jsonl`");
    expect(out).toContain(INDEX_HEADER);
    expect(out).toContain(
      "Then append your packet-ref line below it. Do NOT modify or remove the header.",
    );
  });

  test("emits the append-only step when the header already exists", () => {
    const out = buildArchivePrompt(baseInput({ needsHeader: false }));
    expect(out).toContain(
      "Append **one JSON line** to `.pi/history/index.jsonl`",
    );
    expect(out).not.toContain(INDEX_HEADER);
  });

  test("renders a checkpoint packet and its template filename", () => {
    const out = buildArchivePrompt(baseInput({ packetKind: "checkpoint" }));
    expect(out).toContain("**checkpoint**");
    expect(out).toContain(
      "`2026-07-09T12-34-56.789Z-checkpoint-<slugified-topic>.md`",
    );
    expect(TEMPLATE_FILE.checkpoint).toBe("checkpoint-packet.md");
  });

  test("falls back to the default instruction when none is given", () => {
    const out = buildArchivePrompt(baseInput({ instruction: "" }));
    expect(out).toContain(
      "Summarize the work done in this session and create a comprehensive handoff packet.",
    );
  });

  test("embeds a packet-ref index-entry example with portable path + placeholders", () => {
    const out = buildArchivePrompt(baseInput());
    // extract the json block that follows the shape instructions
    const block = out.match(/```json\n([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const entry = JSON.parse(block![1].trim());
    expect(entry).toMatchObject({
      kind: "packet-ref",
      packetKind: "handoff",
      threadId: "11111111-2222-3333-4444-555555555555",
      timestamp,
      repo: "<repo name>",
      cwd,
      topic: "<topic>",
      summary: "<one-line summary>",
    });
    expect(entry.path).toBe("packets/2026/07/<timestamp>-<kind>-<slug>.md");
  });

  test("is pure — identical input yields identical output", () => {
    const a = buildArchivePrompt(baseInput());
    const b = buildArchivePrompt(baseInput());
    expect(a).toBe(b);
  });
});
