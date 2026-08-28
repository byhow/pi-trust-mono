import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ModelPickerExecutor } from "./process.ts";
import { runModelPicker } from "./runner.ts";

const fixturePath = resolve(
  import.meta.dirname,
  "../contracts/model-picker.selection.v1.fixture.json",
);

describe("runModelPicker", () => {
  test("executes the reviewed launcher and parses canonical output", async () => {
    const exec: ModelPickerExecutor = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: await readFile(fixturePath, "utf8"),
    }));
    const result = await runModelPicker(
      { task: "agent", limit: 1 },
      "/work",
      "/opt/mist/bin/model-picker",
      exec,
    );
    expect(result).toMatchObject({ ok: true, selection: { count: 1 } });
    expect(exec).toHaveBeenCalledWith(
      "/opt/mist/bin/model-picker",
      ["pick", "--task", "agent", "--limit", "1", "--contract"],
      "/work",
      undefined,
    );
  });

  test("rejects missing launchers before execution", async () => {
    const exec = vi.fn<ModelPickerExecutor>();
    expect(
      await runModelPicker({ task: "agent" }, "/work", "model-picker", exec),
    ).toEqual({ ok: false, code: "selector-invalid" });
    expect(exec).not.toHaveBeenCalled();
  });

  test("reports launcher and output failures distinctly", async () => {
    const failed: ModelPickerExecutor = vi.fn(async () => ({
      code: 1,
      killed: false,
      stdout: "",
    }));
    expect(
      await runModelPicker(
        { task: "agent" },
        "/work",
        "/opt/mist/bin/model-picker",
        failed,
      ),
    ).toEqual({ ok: false, code: "selector-missing" });

    const invalid: ModelPickerExecutor = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: "{}",
    }));
    expect(
      await runModelPicker(
        { task: "agent" },
        "/work",
        "/opt/mist/bin/model-picker",
        invalid,
      ),
    ).toEqual({ ok: false, code: "selector-output-invalid" });
  });
});
