import { isAbsolute, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_HISTORY_DIR,
  HISTORY_DIR_ENV,
  resolveHistoryDir,
} from "./paths.ts";

describe("resolveHistoryDir", () => {
  const original = process.env[HISTORY_DIR_ENV];

  beforeEach(() => {
    delete process.env[HISTORY_DIR_ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[HISTORY_DIR_ENV];
    else process.env[HISTORY_DIR_ENV] = original;
  });

  test("defaults to <cwd>/.pi/history when the env var is unset", () => {
    const cwd = "/home/me/project";
    expect(resolveHistoryDir(cwd)).toBe(resolve(cwd, DEFAULT_HISTORY_DIR));
  });

  test("honors an absolute env override verbatim", () => {
    const abs = "/var/lib/pi-history";
    process.env[HISTORY_DIR_ENV] = abs;
    expect(isAbsolute(abs)).toBe(true);
    expect(resolveHistoryDir("/home/me/project")).toBe(abs);
  });

  test("resolves a relative env override against cwd", () => {
    process.env[HISTORY_DIR_ENV] = "custom/history";
    const cwd = "/home/me/project";
    expect(resolveHistoryDir(cwd)).toBe(resolve(cwd, "custom/history"));
  });

  test("treats an empty env override as unset (falls back to default)", () => {
    process.env[HISTORY_DIR_ENV] = "";
    const cwd = "/home/me/project";
    expect(resolveHistoryDir(cwd)).toBe(resolve(cwd, DEFAULT_HISTORY_DIR));
  });
});
