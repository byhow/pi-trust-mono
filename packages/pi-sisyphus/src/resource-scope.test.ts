import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyResourceScope } from "./resource-scope.ts";

const workspace = async () => mkdtemp(join(tmpdir(), "pi-sisyphus-scope-"));

describe("classifyResourceScope", () => {
  test("classifies existing and new paths below the canonical workspace", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "README.md"), "fixture", "utf8");
    await mkdir(join(cwd, "src"));
    expect(
      await classifyResourceScope("Read", { path: "README.md" }, cwd),
    ).toBe("workspace");
    expect(
      await classifyResourceScope("Write", { path: "src/new.ts" }, cwd),
    ).toBe("workspace");
    expect(await classifyResourceScope("Grep", {}, cwd)).toBe("workspace");
  });

  test("classifies outside paths and escaping symlinks as external", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.txt"), "fixture", "utf8");
    await symlink(outside, join(cwd, "linked-outside"));
    expect(
      await classifyResourceScope(
        "Read",
        { path: join(outside, "secret.txt") },
        cwd,
      ),
    ).toBe("external");
    expect(
      await classifyResourceScope(
        "Read",
        { path: "linked-outside/secret.txt" },
        cwd,
      ),
    ).toBe("external");
  });

  test("does not claim scope for non-filesystem or malformed inputs", async () => {
    const cwd = await workspace();
    expect(await classifyResourceScope("Bash", { command: "pwd" }, cwd)).toBe(
      "not-applicable",
    );
    expect(await classifyResourceScope("Read", {}, cwd)).toBe("unknown");
  });
});
