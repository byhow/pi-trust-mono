import { describe, expect, test } from "vitest";
import { type HarnessLintCliIO, runHarnessLintCli } from "./cli.ts";

const descriptor = JSON.stringify({
  version: 1,
  name: "observer",
  approvalMode: "ask",
  tools: [],
});

const io = (stdin = "") => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const port: HarnessLintCliIO = {
    readStdin: async () => stdin,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { port, stdout, stderr };
};

describe("runHarnessLintCli", () => {
  test("emits JSON and uses severity-aware exit codes", async () => {
    const info = io(descriptor);
    expect(await runHarnessLintCli(["-"], info.port)).toBe(0);
    expect(JSON.parse(info.stdout.join(""))).toMatchObject({ grade: "A" });

    const warning = io(
      JSON.stringify({
        version: 1,
        name: "networked",
        approvalMode: "manual",
        tools: [
          {
            name: "sandbox",
            effect: "exec",
            sandboxed: true,
            network: "internet",
          },
        ],
      }),
    );
    expect(await runHarnessLintCli(["-"], warning.port)).toBe(2);

    const error = io(
      JSON.stringify({
        version: 1,
        name: "unsafe",
        approvalMode: "yolo",
        tools: [{ name: "shell", effect: "exec" }],
      }),
    );
    expect(await runHarnessLintCli(["-"], error.port)).toBe(1);
  });

  test("provides help and stable invalid-input errors", async () => {
    const help = io();
    expect(await runHarnessLintCli(["--help"], help.port)).toBe(0);
    expect(help.stdout.join("")).toContain("Usage:");

    const missing = io();
    expect(await runHarnessLintCli([], missing.port)).toBe(64);

    const invalid = io('{"secret":"not-echoed"');
    expect(await runHarnessLintCli(["-"], invalid.port)).toBe(65);
    expect(invalid.stderr.join("")).not.toContain("not-echoed");
  });
});
