import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { spawnModelPicker } from "./process.ts";

const executable = async (body: string): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-model-picker-process-test-"),
  );
  const path = join(directory, "model-picker");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
};

describe("spawnModelPicker", () => {
  test("uses a fixed PATH and disposable private HOME/TMPDIR", async () => {
    const binary = await executable(
      'printf "%s|%s|%s" "$PATH" "$HOME" "$TMPDIR"',
    );
    const result = await spawnModelPicker(binary, [], "/tmp");
    expect(result.killed).toBe(false);
    const [path, home, temporary] = result.stdout.split("|");
    expect(path).toBe("/usr/bin:/bin");
    expect(home).toBe(temporary);
    await expect(access(home ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("kills a timed-out launcher", async () => {
    const binary = await executable("sleep 5");
    const result = await spawnModelPicker(binary, [], "/tmp", undefined, {
      timeoutMs: 25,
    });
    expect(result.killed).toBe(true);
    expect(result.stdout).toBe("");
  });

  test("kills oversized output and observes caller abort", async () => {
    const oversized = await executable("yes x | head -c 4096");
    expect(
      await spawnModelPicker(oversized, [], "/tmp", undefined, {
        maxOutputBytes: 128,
      }),
    ).toMatchObject({ killed: true, stdout: "" });

    const slow = await executable("sleep 5");
    const controller = new AbortController();
    controller.abort();
    expect(
      await spawnModelPicker(slow, [], "/tmp", controller.signal),
    ).toMatchObject({ killed: true, stdout: "" });
  });
});
