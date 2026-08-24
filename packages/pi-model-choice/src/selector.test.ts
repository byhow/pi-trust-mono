import { describe, expect, test } from "vitest";
import { selection } from "../test/selection-fixture.ts";
import {
  buildModelPickerArguments,
  parseModelSelectionOutput,
  resolveModelPickerBinary,
} from "./selector.ts";

describe("resolveModelPickerBinary", () => {
  test("uses PATH by default and accepts only an exact absolute launcher override", () => {
    expect(resolveModelPickerBinary(undefined)).toBe("model-picker");
    expect(resolveModelPickerBinary("/opt/model-picker/bin/model-picker")).toBe(
      "/opt/model-picker/bin/model-picker",
    );
    expect(resolveModelPickerBinary("relative/model-picker")).toBeUndefined();
    expect(
      resolveModelPickerBinary("/opt/model-picker/bin/node"),
    ).toBeUndefined();
    expect(
      resolveModelPickerBinary("/opt/model-picker\n/bin/model-picker"),
    ).toBeUndefined();
  });
});

describe("buildModelPickerArguments", () => {
  test("builds one non-shell argv contract", () => {
    expect(
      buildModelPickerArguments({
        task: "coding",
        filter: "provider=openai",
        limit: 2,
        weights: { speed: 0.5, price: 0.3, context: 0.2 },
      }),
    ).toEqual([
      "pick",
      "--task",
      "coding",
      "--limit",
      "2",
      "--contract",
      "--filter",
      "provider=openai",
      "--weights",
      "speed=0.5,price=0.3,context=0.2",
    ]);
  });

  test.each([
    { task: "unknown" },
    { task: "agent", limit: 0 },
    { task: "agent", limit: 11 },
    { task: "agent", filter: "" },
    { task: "agent", weights: {} },
    { task: "agent", weights: { speed: -1 } },
  ])("rejects invalid selector request %#", (request) => {
    expect(buildModelPickerArguments(request as never)).toBeUndefined();
  });
});

describe("parseModelSelectionOutput", () => {
  test("accepts the exact v1 envelope", () => {
    expect(parseModelSelectionOutput(JSON.stringify(selection))).toEqual({
      ok: true,
      selection,
    });
  });

  test.each([
    "not-json",
    JSON.stringify({ ...selection, version: 2 }),
    JSON.stringify({ ...selection, count: 2 }),
    JSON.stringify({
      ...selection,
      choices: [{ ...selection.choices[0], score: "high" }],
    }),
    JSON.stringify({
      ...selection,
      choices: [{ ...selection.choices[0], reasons: [42] }],
    }),
    "x".repeat(256 * 1024 + 1),
  ])("rejects malformed selector output without throwing", (raw) => {
    expect(parseModelSelectionOutput(raw)).toEqual({
      ok: false,
      code: "selector-output-invalid",
    });
  });
});
