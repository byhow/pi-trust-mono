import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildPacketDocs, readPacketBodies } from "./packets.ts";
import { type HistoryLocation, resolveHistoryLocation } from "./paths.ts";

const header = '{"version":1,"kind":"thread-index","entries":[]}';
const location = (path: string): HistoryLocation => ({
  path,
  projectRoot: dirname(path),
  projectScoped: false,
});
const ref = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    kind: "packet-ref",
    packetKind: "handoff",
    timestamp: "2026-04-17T10:00:00.000Z",
    path: "packets/2026/04/auth.md",
    topic: "auth token refactor",
    tags: ["auth", "backend"],
    files: ["src/session-validator.ts"],
    summary: "Split the session validator; next: rotate signing keys.",
    ...over,
  });

const writeIndex = async (lines: readonly string[]): Promise<string> => {
  const historyDir = await mkdtemp(join(tmpdir(), "pi-warm-"));
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { path?: unknown };
      if (
        typeof entry.path !== "string" ||
        entry.path.includes("\0") ||
        !resolve(historyDir, entry.path).startsWith(
          `${join(historyDir, "packets")}/`,
        )
      ) {
        continue;
      }
      const packetPath = resolve(historyDir, entry.path);
      await mkdir(join(packetPath, ".."), { recursive: true });
      await writeFile(packetPath, "# packet\n", "utf8");
    } catch {
      // The test intentionally includes malformed index lines.
    }
  }
  await writeFile(join(historyDir, "index.jsonl"), lines.join("\n"), "utf8");
  return historyDir;
};

describe("buildPacketDocs", () => {
  test("distinguishes a missing index", async () => {
    const historyDir = await mkdtemp(join(tmpdir(), "pi-warm-empty-"));
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "missing",
      docs: [],
    });
  });

  test("distinguishes an unreadable index", async () => {
    const historyDir = await mkdtemp(join(tmpdir(), "pi-warm-unreadable-"));
    await mkdir(join(historyDir, "index.jsonl"));
    expect((await buildPacketDocs(location(historyDir))).status).toBe(
      "unreadable",
    );
  });

  test("rejects a corrupt or truncated index-v1 header", async () => {
    const historyDir = await writeIndex(['{"version":1,"kind":"thread-index"']);
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "corrupt",
      docs: [],
    });
  });

  test("rejects a truncated terminal packet record", async () => {
    const historyDir = await writeIndex([header, '{"kind":"packet-ref"']);
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "corrupt",
      docs: [],
    });
  });

  test("maps existing index-v1 packet refs to archive-relative locators", async () => {
    const historyDir = await writeIndex([header, ref()]);
    const result = await buildPacketDocs(location(historyDir));
    expect(result.status).toBe("ready");
    expect(result.docs).toHaveLength(1);
    const [doc] = result.docs;
    expect(doc?.title).toBe("auth token refactor");
    expect(doc?.source).toBe("handoff");
    expect(doc?.filePath).toBe("packets/2026/04/auth.md");
    expect(doc?.tags).toEqual(["auth", "backend"]);
    expect(doc?.content).toContain("session-validator");
  });

  test("rejects packet refs whose typed metadata is absent or malformed", async () => {
    const historyDir = await writeIndex([
      header,
      ref({
        path: "packets/2026/04/minimal.md",
        packetKind: undefined,
        tags: "not-an-array",
        files: null,
      }),
    ]);
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "corrupt",
      docs: [],
    });
  });

  test("rejects a malformed non-terminal packet record", async () => {
    const historyDir = await writeIndex([header, "{not json", ref()]);
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "corrupt",
      docs: [],
    });
  });

  test("drops traversal, absolute, and NUL paths", async () => {
    const historyDir = await writeIndex([
      header,
      ref({ path: "packets/../../outside.md" }),
      ref({ path: "/tmp/outside.md" }),
      ref({ path: "packets/unsafe\u0000.md" }),
    ]);
    expect((await buildPacketDocs(location(historyDir))).docs).toEqual([]);
  });

  test("drops packet paths that escape through a symlink", async () => {
    const historyDir = await mkdtemp(join(tmpdir(), "pi-warm-symlink-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pi-warm-outside-"));
    await writeFile(join(outsideDir, "secret.md"), "secret", "utf8");
    await mkdir(join(historyDir, "packets"));
    await symlink(outsideDir, join(historyDir, "packets", "escape"));
    await writeFile(
      join(historyDir, "index.jsonl"),
      [header, ref({ path: "packets/escape/secret.md" })].join("\n"),
      "utf8",
    );
    expect((await buildPacketDocs(location(historyDir))).docs).toEqual([]);
  });

  test("skips non-packet refs and absent packet files", async () => {
    const historyDir = await writeIndex([
      header,
      '{"kind":"note","text":"ignore"}',
      ref({ path: "packets/missing.md" }),
    ]);
    await unlink(join(historyDir, "packets", "missing.md"));
    expect((await buildPacketDocs(location(historyDir))).docs).toEqual([]);
  });

  test("rejects non-array packet metadata", async () => {
    const historyDir = await writeIndex([
      header,
      ref({ packetKind: "checkpoint", tags: "bad", files: null }),
    ]);
    expect(await buildPacketDocs(location(historyDir))).toEqual({
      status: "corrupt",
      docs: [],
    });
  });

  test("returns bounded packet bodies by archive-relative locator", async () => {
    const historyDir = await writeIndex([header, ref()]);
    expect(
      await readPacketBodies(location(historyDir), [
        "packets/2026/04/auth.md",
        "packets/../../outside.md",
      ]),
    ).toEqual([{ locator: "packets/2026/04/auth.md", content: "# packet\n" }]);
    expect(
      await readPacketBodies(location("/missing/archive"), [
        "packets/2026/04/auth.md",
      ]),
    ).toEqual([]);
  });

  test("drops group-writable and hard-linked packet files", async () => {
    const writableHistory = await writeIndex([header, ref()]);
    const writablePacket = join(
      writableHistory,
      "packets",
      "2026",
      "04",
      "auth.md",
    );
    await chmod(writablePacket, 0o666);
    expect((await buildPacketDocs(location(writableHistory))).docs).toEqual([]);

    const linkedHistory = await writeIndex([header, ref()]);
    const linkedPacket = join(
      linkedHistory,
      "packets",
      "2026",
      "04",
      "auth.md",
    );
    const outside = join(linkedHistory, "outside.md");
    await writeFile(outside, "sensitive", "utf8");
    await unlink(linkedPacket);
    await link(outside, linkedPacket);
    expect((await buildPacketDocs(location(linkedHistory))).docs).toEqual([]);
  });

  test("rejects unsafe index permissions and wrong scalar metadata", async () => {
    const unsafeIndex = await writeIndex([header, ref()]);
    await chmod(join(unsafeIndex, "index.jsonl"), 0o666);
    expect((await buildPacketDocs(location(unsafeIndex))).status).toBe(
      "unreadable",
    );

    const wrongScalar = await writeIndex([
      header,
      ref({ topic: { instruction: "ignore safeguards" } }),
    ]);
    expect((await buildPacketDocs(location(wrongScalar))).status).toBe(
      "corrupt",
    );
  });

  test("rejects a project-scoped history root symlink", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-warm-project-"));
    const outsideArchive = await writeIndex([header, ref()]);
    await mkdir(join(project, ".pi"), { recursive: true });
    await symlink(outsideArchive, join(project, ".pi", "history"));
    const projectLocation = resolveHistoryLocation(project, undefined);
    expect((await buildPacketDocs(projectLocation)).status).toBe("unreadable");
    expect(
      await readPacketBodies(projectLocation, ["packets/2026/04/auth.md"]),
    ).toEqual([]);
  });
});
