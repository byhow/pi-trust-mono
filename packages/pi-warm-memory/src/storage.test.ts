import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ArchiveDraft } from "./commands/archive-core.ts";
import { resolveHistoryLocation } from "./paths.ts";
import { persistArchive } from "./storage.ts";

const draft: ArchiveDraft = {
  packetKind: "handoff",
  topic: "auth refactor",
  summary: "Split validation from token rotation.",
  tags: ["auth", "backend"],
  files: ["src/auth.ts"],
  nextStep: "Rotate the signing key through the approved operator workflow.",
  goal: "Finish the auth refactor safely.",
  decisions: ["Keep validation independent from key storage."],
  commands: ["npm test"],
  blockers: [],
  openQuestions: ["Which rollout window is approved?"],
  changes: [],
  pendingDecisions: [],
};

const timestamp = "2026-08-23T15:00:00.000Z";

const createProject = async () => mkdtemp(join(tmpdir(), "pi-warm-storage-"));

describe("persistArchive", () => {
  test("creates a private packet and one append-only index record", async () => {
    const cwd = await createProject();
    const result = await persistArchive(
      resolveHistoryLocation(cwd, undefined),
      "session-123",
      timestamp,
      "fixture-project",
      undefined,
      draft,
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const historyRoot = join(cwd, ".pi", "history");
    expect(await readFile(join(historyRoot, ".gitignore"), "utf8")).toBe(
      "*\n!.gitignore\n",
    );
    const packet = await readFile(join(historyRoot, result.locator), "utf8");
    expect(packet).toContain("- Thread ID: session-123");
    expect(packet).toContain("- Repository: fixture-project");

    const indexLines = (
      await readFile(join(historyRoot, "index.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n");
    expect(indexLines).toHaveLength(2);
    expect(JSON.parse(indexLines[1] ?? "")).toMatchObject({
      kind: "packet-ref",
      path: result.locator,
      threadId: "session-123",
    });
  });

  test("does not create a packet when an existing index is corrupt", async () => {
    const cwd = await createProject();
    const historyRoot = join(cwd, ".pi", "history");
    await mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(historyRoot, "index.jsonl"), "not-index-v1", {
      mode: 0o600,
    });

    const result = await persistArchive(
      resolveHistoryLocation(cwd, undefined),
      "session-123",
      timestamp,
      "fixture-project",
      undefined,
      draft,
    );
    expect(result.status).not.toBe("success");
    const packetDir = join(historyRoot, "packets", "2026", "08");
    expect(await readdir(packetDir)).toEqual([]);
  });

  test("rejects a symlinked packet directory without writing outside", async () => {
    const cwd = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "pi-warm-outside-"));
    const historyRoot = join(cwd, ".pi", "history");
    await mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await symlink(outside, join(historyRoot, "packets"));

    const result = await persistArchive(
      resolveHistoryLocation(cwd, undefined),
      "session-123",
      timestamp,
      "fixture-project",
      undefined,
      draft,
    );
    expect(result.status).toBe("unsafe");
    expect(await readdir(outside)).toEqual([]);
  });

  test("requires explicit opt-in before omitting the private Git marker", async () => {
    const cwd = await createProject();
    const result = await persistArchive(
      resolveHistoryLocation(cwd, undefined),
      "session-123",
      timestamp,
      "fixture-project",
      "true",
      draft,
    );
    expect(result.status).toBe("success");
    await expect(
      stat(join(cwd, ".pi", "history", ".gitignore")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("refuses to overwrite a packet with the same timestamp and topic", async () => {
    const cwd = await createProject();
    const location = resolveHistoryLocation(cwd, undefined);
    expect(
      (
        await persistArchive(
          location,
          "session-123",
          timestamp,
          "fixture-project",
          undefined,
          draft,
        )
      ).status,
    ).toBe("success");
    expect(
      (
        await persistArchive(
          location,
          "session-123",
          timestamp,
          "fixture-project",
          undefined,
          draft,
        )
      ).status,
    ).toBe("collision");
  });

  test("renders checkpoint packets in an explicit absolute archive", async () => {
    const cwd = await createProject();
    const absoluteRoot = await mkdtemp(join(tmpdir(), "pi-warm-global-"));
    const result = await persistArchive(
      resolveHistoryLocation(cwd, absoluteRoot),
      "session-checkpoint",
      "2026-08-23T15:01:00.000Z",
      "fixture-project",
      undefined,
      {
        ...draft,
        packetKind: "checkpoint",
        changes: ["Added a bounded storage writer."],
        risk: "The rollout is not active.",
        pendingDecisions: ["Choose the release window."],
      },
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const packet = await readFile(join(absoluteRoot, result.locator), "utf8");
    expect(packet).toContain("# Checkpoint Packet");
    expect(packet).toContain("- Current Risk: The rollout is not active.");
    expect(packet).toContain("  - Added a bounded storage writer.");
  });

  test.each([
    ["", timestamp, "fixture-project"],
    ["session-123", "bad-timestamp", "fixture-project"],
    ["session-123", timestamp, "bad\nrepository"],
  ])(
    "rejects unsafe derived metadata %#",
    async (sessionId, at, repository) => {
      const cwd = await createProject();
      expect(
        (
          await persistArchive(
            resolveHistoryLocation(cwd, undefined),
            sessionId,
            at,
            repository,
            undefined,
            draft,
          )
        ).status,
      ).toBe("unsafe");
    },
  );

  test("appends safely when the existing index lacks a final newline", async () => {
    const cwd = await createProject();
    const location = resolveHistoryLocation(cwd, undefined);
    await persistArchive(
      location,
      "session-123",
      timestamp,
      "fixture-project",
      undefined,
      draft,
    );
    const indexPath = join(cwd, ".pi", "history", "index.jsonl");
    await writeFile(
      indexPath,
      (await readFile(indexPath, "utf8")).trimEnd(),
      "utf8",
    );
    const second = await persistArchive(
      location,
      "session-456",
      "2026-08-23T15:02:00.000Z",
      "fixture-project",
      undefined,
      { ...draft, topic: "second packet" },
    );
    expect(second.status).toBe("success");
    expect(
      (await readFile(indexPath, "utf8")).trimEnd().split("\n"),
    ).toHaveLength(3);
  });

  test("rejects a group-writable index", async () => {
    const cwd = await createProject();
    const historyRoot = join(cwd, ".pi", "history");
    await mkdir(historyRoot, { recursive: true, mode: 0o700 });
    const indexPath = join(historyRoot, "index.jsonl");
    await writeFile(
      indexPath,
      '{"version":1,"kind":"thread-index","entries":[]}\n',
      { mode: 0o660 },
    );
    await chmod(indexPath, 0o660);
    expect(
      (
        await persistArchive(
          resolveHistoryLocation(cwd, undefined),
          "session-123",
          timestamp,
          "fixture-project",
          undefined,
          draft,
        )
      ).status,
    ).toBe("unsafe");
  });

  test("rejects an existing non-protective Git marker", async () => {
    const cwd = await createProject();
    const historyRoot = join(cwd, ".pi", "history");
    await mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(historyRoot, ".gitignore"), "# not protective\n", {
      mode: 0o600,
    });
    const result = await persistArchive(
      resolveHistoryLocation(cwd, undefined),
      "session-123",
      timestamp,
      "fixture-project",
      undefined,
      draft,
    );
    expect(result.status).toBe("unsafe");
    await expect(stat(join(historyRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
