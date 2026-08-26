import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runModelPicker } from "./runner.ts";

const fixturePath = resolve(
  import.meta.dirname,
  "../contracts/model-picker.selection.v1.fixture.json",
);

describe("runModelPicker", () => {
  test("executes the reviewed launcher and parses canonical output", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: await readFile(fixturePath, "utf8"),
      stderr: "",
    }));
    const result = await runModelPicker(
      { exec } as never,
      { task: "agent", limit: 1 },
      "/work",
      "/opt/mist/bin/model-picker",
    );
    expect(result).toMatchObject({ ok: true, selection: { count: 1 } });
    expect(exec).toHaveBeenCalledWith(
      "/opt/mist/bin/model-picker",
      ["pick", "--task", "agent", "--limit", "1", "--contract"],
      { cwd: "/work" },
    );
  });

  test("rejects missing launchers before execution", async () => {
    const exec = vi.fn();
    expect(
      await runModelPicker(
        { exec } as never,
        { task: "agent" },
        "/work",
        "model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-invalid" });
    expect(exec).not.toHaveBeenCalled();
  });

  test("reports launcher and output failures distinctly", async () => {
    const failed = vi.fn(async () => ({
      code: 1,
      killed: false,
      stdout: "",
      stderr: "failed",
    }));
    expect(
      await runModelPicker(
        { exec: failed } as never,
        { task: "agent" },
        "/work",
        "/opt/mist/bin/model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-missing" });

    const invalid = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: "{}",
      stderr: "",
    }));
    expect(
      await runModelPicker(
        { exec: invalid } as never,
        { task: "agent" },
        "/work",
        "/opt/mist/bin/model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-output-invalid" });
  });
});
