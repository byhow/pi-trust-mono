import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildModelPickerArguments,
  MODEL_SELECTION_SCHEMA_SHA256,
  parseModelSelectionOutput,
  resolveModelPickerBinary,
} from "./selector.ts";

const fixturePath = resolve(
  import.meta.dirname,
  "../contracts/model-picker.selection.v1.fixture.json",
);
const schemaPath = resolve(
  import.meta.dirname,
  "../contracts/model-picker.selection.v1.schema.json",
);

describe("resolveModelPickerBinary", () => {
  test("accepts only an absolute reviewed model-picker launcher", () => {
    expect(resolveModelPickerBinary("/opt/mist/bin/model-picker")).toBe(
      "/opt/mist/bin/model-picker",
    );
    expect(resolveModelPickerBinary("model-picker")).toBeUndefined();
    expect(resolveModelPickerBinary("/opt/mist/bin/mp")).toBeUndefined();
  });
});

describe("buildModelPickerArguments", () => {
  test("builds the canonical contract request", () => {
    expect(
      buildModelPickerArguments({
        task: "agent",
        filter: "provider=openai",
        limit: 3,
        weights: { speed: 0.5, price: 0.3, context: 0.2 },
      }),
    ).toEqual([
      "pick",
      "--task",
      "agent",
      "--limit",
      "3",
      "--contract",
      "--filter",
      "provider=openai",
      "--weights",
      "speed=0.5,price=0.3,context=0.2",
    ]);
  });

  test("rejects invalid tasks, limits, filters, and weights", () => {
    expect(
      buildModelPickerArguments({ task: "unknown" } as never),
    ).toBeUndefined();
    expect(
      buildModelPickerArguments({ task: "agent", limit: 11 }),
    ).toBeUndefined();
    expect(
      buildModelPickerArguments({ task: "agent", filter: "" }),
    ).toBeUndefined();
    expect(
      buildModelPickerArguments({ task: "agent", weights: { speed: 2 } }),
    ).toBeUndefined();
  });
});

describe("parseModelSelectionOutput", () => {
  test("accepts the canonical producer fixture", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    expect(parseModelSelectionOutput(fixture)).toMatchObject({
      ok: true,
      selection: { contract: "model-picker.selection", version: 1, count: 1 },
    });
  });

  test("rejects schema and cross-field violations", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(
      parseModelSelectionOutput(JSON.stringify({ ...fixture, extra: true })),
    ).toEqual({ ok: false, code: "selector-output-invalid" });
    expect(
      parseModelSelectionOutput(JSON.stringify({ ...fixture, count: 0 })),
    ).toEqual({ ok: false, code: "selector-output-invalid" });
    expect(
      parseModelSelectionOutput(
        JSON.stringify({
          ...fixture,
          request: { ...fixture.request, limit: 0 },
        }),
      ),
    ).toEqual({ ok: false, code: "selector-output-invalid" });
  });

  test("pins the exact producer schema artifact", async () => {
    const digest = createHash("sha256")
      .update(await readFile(schemaPath))
      .digest("hex");
    expect(digest).toBe(MODEL_SELECTION_SCHEMA_SHA256);
  });
});
