import { isAbsolute, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_HISTORY_DIR, resolveHistoryLocation } from "./paths.ts";

describe("resolveHistoryLocation", () => {
  test("defaults to <cwd>/.pi/history when no adapter configuration is supplied", () => {
    const cwd = "/home/me/project";
    expect(resolveHistoryLocation(cwd, undefined).path).toBe(
      resolve(cwd, DEFAULT_HISTORY_DIR),
    );
  });

  test("accepts an inherited adapter configuration", () => {
    const cwd = "/home/me/project";
    expect(resolveHistoryLocation(cwd, "inherited/history").path).toBe(
      resolve(cwd, "inherited/history"),
    );
  });

  test("honors an absolute override verbatim", () => {
    const absolute = "/var/lib/pi-history";
    expect(isAbsolute(absolute)).toBe(true);
    expect(resolveHistoryLocation("/home/me/project", absolute).path).toBe(
      absolute,
    );
  });

  test("resolves a relative override against cwd", () => {
    const cwd = "/home/me/project";
    expect(resolveHistoryLocation(cwd, "custom/history").path).toBe(
      resolve(cwd, "custom/history"),
    );
  });

  test("treats an empty override as absent", () => {
    const cwd = "/home/me/project";
    expect(resolveHistoryLocation(cwd, "").path).toBe(
      resolve(cwd, DEFAULT_HISTORY_DIR),
    );
  });
});
