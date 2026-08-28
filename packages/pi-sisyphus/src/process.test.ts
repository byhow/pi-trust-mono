import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { spawnSisyphus } from "./process.ts";

const executable = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sisyphus-process-test-"));
  const path = join(directory, "sy");
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
};

describe("spawnSisyphus", () => {
  test("uses a fixed PATH and disposable private HOME/TMPDIR", async () => {
    const binary = await executable(
      'cat >/dev/null; printf "%s|%s|%s" "$PATH" "$HOME" "$TMPDIR"',
    );
    const result = await spawnSisyphus(binary, ["evaluate", "-"], "{}", {
      PATH: "/attacker/bin",
      HOME: "/attacker/home",
    });
    expect(result.killed).toBe(false);
    const [path, home, temporary] = result.stdout.split("|");
    expect(path).toBe("/usr/bin:/bin");
    expect(home).toBe(temporary);
    expect(home).not.toBe("/attacker/home");
    await expect(access(home ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("kills a timed-out launcher", async () => {
    const binary = await executable("sleep 5");
    const result = await spawnSisyphus(binary, [], "", {}, { timeoutMs: 25 });
    expect(result).toEqual({ code: -1, killed: true, stdout: "" });
  });

  test("kills a launcher that exceeds the output cap", async () => {
    const binary = await executable("yes x | head -c 4096");
    const result = await spawnSisyphus(
      binary,
      [],
      "",
      {},
      {
        maxOutputBytes: 128,
      },
    );
    expect(result.killed).toBe(true);
    expect(result.stdout).toBe("");
  });
});
