import { describe, expect, test, vi } from "vitest";
import { createToolPolicyHandler } from "./extension.ts";
import type { PolicyDecision, PolicyEvaluation } from "./types.ts";

const context = {
  cwd: "/workspace",
  ui: { notify: vi.fn() },
};
const event = {
  type: "tool_call" as const,
  toolCallId: "call-1",
  toolName: "bash",
  input: { command: "git status" },
};
const decision = (effect: PolicyDecision["effect"]): PolicyEvaluation => ({
  ok: true,
  decision: {
    effect,
    reason: `${effect} by fixture policy`,
    ...(effect === "modify"
      ? { modified: { command: "git status --short" } }
      : {}),
    policy: { bundle: "fixture", rule: effect, revision: "1.0.0" },
  },
});

describe("createToolPolicyHandler", () => {
  test("allows only an explicit allow decision", async () => {
    const handler = createToolPolicyHandler(async () => decision("allow"));
    expect(await handler(event, context)).toBeUndefined();
  });

  test.each([
    ["deny", "Policy denied this tool call"],
    ["ask", "Explicit operator approval is required"],
    ["modify", "Policy proposed a rewrite"],
  ] as const)(
    "blocks %s without treating it as authorization",
    async (effect, text) => {
      const handler = createToolPolicyHandler(async () => decision(effect));
      expect(await handler(event, context)).toEqual({
        block: true,
        reason: expect.stringContaining(text),
      });
    },
  );

  test("fails closed on unavailable and defective evaluators", async () => {
    const unavailable = createToolPolicyHandler(async () => ({
      ok: false,
      code: "engine-unavailable",
    }));
    expect(await unavailable(event, context)).toEqual({
      block: true,
      reason: "Policy enforcement failed closed (engine-unavailable).",
    });

    const defective = createToolPolicyHandler(async () => {
      throw new Error("defect");
    });
    expect(await defective(event, context)).toEqual({
      block: true,
      reason: "Policy enforcement failed closed (engine-unavailable).",
    });
  });

  test("keeps the package diagnostic tool available without recursion", async () => {
    const evaluate = vi.fn(async () => decision("deny"));
    const handler = createToolPolicyHandler(evaluate);
    expect(
      await handler({ ...event, toolName: "agent_permit" }, context),
    ).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
