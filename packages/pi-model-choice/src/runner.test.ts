import { describe, expect, test, vi } from "vitest";
import { selection } from "../test/selection-fixture.ts";
import { runModelChoice } from "./runner.ts";

describe("runModelChoice", () => {
  test("executes the selector as argv and parses its versioned output", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: JSON.stringify(selection),
    }));
    const result = await runModelChoice(
      { exec },
      { task: "agent", limit: 1 },
      "/workspace",
      "/opt/bin/model-picker",
    );
    expect(result).toEqual({ ok: true, selection });
    expect(exec).toHaveBeenCalledWith(
      "/opt/bin/model-picker",
      ["pick", "--task", "agent", "--limit", "1", "--contract"],
      { cwd: "/workspace" },
    );
  });

  test("returns stable failures for invalid configuration and process errors", async () => {
    const exec = vi.fn(async () => ({
      code: 1,
      killed: false,
      stdout: "secret",
    }));
    expect(
      await runModelChoice(
        { exec },
        { task: "agent" },
        "/workspace",
        "relative/model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-invalid" });
    expect(
      await runModelChoice(
        { exec },
        { task: "agent" },
        "/workspace",
        "/opt/bin/model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-missing" });

    const throws = vi.fn(async () => {
      throw new Error("not found");
    });
    expect(
      await runModelChoice(
        { exec: throws },
        { task: "agent" },
        "/workspace",
        "/opt/bin/model-picker",
      ),
    ).toEqual({ ok: false, code: "selector-missing" });
  });
});
