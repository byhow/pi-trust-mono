import { describe, expect, test } from "vitest";
import { lintHarness, parseHarnessDescriptor } from "./lint.ts";

const secure = {
  version: 1,
  name: "secure-harness",
  approvalMode: "manual",
  bashDenyPatterns: 4,
  tools: [
    { name: "read", effect: "read", sandboxed: true, network: "none" },
    { name: "bash", effect: "exec", sandboxed: true, network: "none" },
  ],
  mcp: [{ name: "docs", vetted: true }],
  persistence: {
    controlJournal: true,
    sensitiveTranscript: true,
    privatePermissions: true,
  },
  autonomy: {
    subagents: true,
    isolatedWorktrees: true,
    maxIterations: 20,
  },
  secrets: [{ source: "credential-store", exposedToModel: false }],
} as const;

describe("parseHarnessDescriptor", () => {
  test("accepts the bounded version-1 descriptor", () => {
    expect(parseHarnessDescriptor(secure)).toEqual(secure);
  });

  test.each([
    null,
    [],
    {},
    { ...secure, version: 2 },
    { ...secure, name: "" },
    { ...secure, approvalMode: "always" },
    { ...secure, tools: "read" },
    { ...secure, tools: [{ name: "bash", effect: "execute" }] },
    { ...secure, mcp: [{ name: "docs", vetted: "yes" }] },
    { ...secure, bashDenyPatterns: -1 },
    { ...secure, persistence: { controlJournal: "yes" } },
    { ...secure, autonomy: { maxIterations: 0 } },
    { ...secure, autonomy: { maxCostUsd: -1 } },
    { ...secure, secrets: [{ source: "prompt", exposedToModel: true }] },
  ])("rejects malformed harness descriptor %#", (value) => {
    expect(parseHarnessDescriptor(value)).toBeUndefined();
    expect(lintHarness(value)).toMatchObject({
      score: 0,
      grade: "F",
      findings: [{ code: "descriptor.invalid", severity: "error" }],
    });
  });
});

describe("lintHarness", () => {
  test("returns a clean report for explicit bounded controls", () => {
    expect(lintHarness(secure)).toEqual({
      version: 1,
      subject: "agent-harness",
      harness: "secure-harness",
      score: 100,
      grade: "A",
      findings: [],
    });
  });

  test("finds unsafe execution, MCP, persistence, autonomy, and secret exposure", () => {
    const report = lintHarness({
      version: 1,
      name: "unsafe",
      approvalMode: "yolo",
      bashDenyPatterns: 0,
      tools: [
        { name: "shell", effect: "exec", network: "internet" },
        { name: "shell", effect: "exec", network: "internet" },
      ],
      mcp: [{ name: "unknown", vetted: false }],
      persistence: {
        sensitiveTranscript: true,
        privatePermissions: false,
        controlJournal: false,
      },
      autonomy: {
        subagents: true,
        isolatedWorktrees: false,
      },
      secrets: [{ source: "env", exposedToModel: true }],
    });
    expect(report.score).toBe(0);
    expect(report.grade).toBe("F");
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "approval.yolo-without-tripwire",
      "tool.exec-unsandboxed",
      "tool.exec-internet",
      "tool.exec-unsandboxed",
      "tool.exec-internet",
      "tool.duplicate-name",
      "mcp.unvetted",
      "persistence.transcript-permissions",
      "persistence.control-journal-missing",
      "autonomy.shared-worktree",
      "autonomy.unbounded",
      "secrets.model-exposure",
    ]);
  });

  test("reports an empty capability surface without treating it as unsafe", () => {
    expect(
      lintHarness({
        version: 1,
        name: "observer",
        approvalMode: "ask",
        tools: [],
      }),
    ).toMatchObject({
      score: 98,
      grade: "A",
      findings: [{ code: "tools.empty", severity: "info" }],
    });
  });
});
