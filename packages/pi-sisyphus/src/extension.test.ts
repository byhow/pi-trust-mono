import { describe, expect, test, vi } from "vitest";
import {
  createPiSisyphusExtension,
  createToolPolicyHandler,
} from "./extension.ts";
import type { McpVetResult, TrustEvaluation } from "./types.ts";

const decision = (
  effect: "allow" | "deny" | "ask" | "modify",
): TrustEvaluation => ({
  ok: true,
  decision: {
    version: 1,
    requestId: "call-1",
    effect,
    reason: `${effect} reason`,
    ...(effect === "modify" ? { modified: { path: "SAFE.md" } } : {}),
    policy: { bundle: "safe", rule: effect, revision: "1" },
  },
});

const evidenceServer = {
  name: "docs",
  transport: "http" as const,
  endpoint: "http:https://mcp.example.test",
  argumentShape: [],
  provenance: {},
  rootClassifications: [],
  capabilities: {},
};
const evidence: McpVetResult = {
  ok: true,
  evidence: {
    version: 1,
    subject: "mcp-connect",
    advisoryEffect: "ask",
    descriptorIdentity: JSON.stringify({
      ...evidenceServer,
      credentialKeys: [],
    }),
    server: evidenceServer,
    credentialKeys: [],
    findings: [],
  },
};

const event = {
  type: "tool_call" as const,
  toolCallId: "call-1",
  toolName: "read",
  input: { path: "README.md" },
};
const context = { cwd: "/work" } as never;

describe("createToolPolicyHandler", () => {
  test("allows only an exact allow decision", async () => {
    const evaluate = vi.fn(async () => decision("allow"));
    expect(
      await createToolPolicyHandler(evaluate)(event as never, context),
    ).toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith({
      version: 1,
      requestId: "call-1",
      subject: "tool-call",
      payload: {
        path: "README.md",
        tool: "Read",
        resourceScope: "unknown",
      },
      context: { cwd: "/work", actor: "agent" },
    });
  });

  test.each([
    ["find", "Find"],
    ["ls", "Ls"],
  ] as const)(
    "normalizes %s for reviewed policy matching",
    async (toolName, policyName) => {
      const evaluate = vi.fn(async () => decision("allow"));
      await createToolPolicyHandler(evaluate)(
        { ...event, toolName } as never,
        context,
      );
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ tool: policyName }),
        }),
      );
    },
  );

  test.each(["deny", "ask", "modify"] as const)(
    "blocks %s decisions",
    async (effect) => {
      const result = await createToolPolicyHandler(async () =>
        decision(effect),
      )(event as never, context);
      expect(result).toMatchObject({ block: true });
    },
  );

  test("fails closed when evaluation is unavailable or throws", async () => {
    expect(
      await createToolPolicyHandler(async () => ({
        ok: false,
        code: "engine-unavailable",
      }))(event as never, context),
    ).toEqual({
      block: true,
      reason: "Policy enforcement failed closed (engine-unavailable).",
    });
    expect(
      await createToolPolicyHandler(async () => {
        throw new Error("failure");
      })(event as never, context),
    ).toEqual({
      block: true,
      reason: "Policy enforcement failed closed (engine-unavailable).",
    });
  });

  test.each(["sisyphus_policy", "mcp_vet"])(
    "does not recursively intercept %s",
    async (toolName) => {
      const evaluate = vi.fn();
      expect(
        await createToolPolicyHandler(evaluate)(
          { ...event, toolName } as never,
          context,
        ),
      ).toBeUndefined();
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
});

type RegisteredTool = {
  execute: (...args: never[]) => Promise<{
    details: unknown;
    isError?: boolean;
  }>;
};
type RegisteredCommand = {
  handler: (args: string, context: never) => Promise<void>;
};

const register = (
  evaluate: (input: never) => Promise<TrustEvaluation>,
  vet: (descriptor: never) => Promise<McpVetResult>,
) => {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events: string[] = [];
  const sendUserMessage = vi.fn();
  createPiSisyphusExtension({ evaluate: evaluate as never, vet: vet as never })(
    {
      on(name: string) {
        events.push(name);
      },
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendUserMessage,
    } as never,
  );
  return { commands, events, sendUserMessage, tools };
};

const commandContext = () => ({
  cwd: "/work",
  ui: { notify: vi.fn() },
});

describe("pi-sisyphus diagnostics", () => {
  test("registers the manifest surfaces", () => {
    const registered = register(
      async () => decision("allow"),
      async () => evidence,
    );
    expect(registered.events).toEqual(["tool_call"]);
    expect([...registered.tools.keys()]).toEqual([
      "sisyphus_policy",
      "mcp_vet",
    ]);
    expect([...registered.commands.keys()]).toEqual(["permit", "mcp-vet"]);
  });

  test("executes both diagnostic tools through injected services", async () => {
    const evaluate = vi.fn(async () => decision("deny"));
    const vet = vi.fn(async () => evidence);
    const { tools } = register(evaluate, vet);
    const policyResult = await tools
      .get("sisyphus_policy")
      ?.execute(
        "call-1" as never,
        { toolName: "read", input: { path: "README.md" } } as never,
        undefined as never,
        undefined as never,
        { cwd: "/work" } as never,
      );
    expect(policyResult).toMatchObject({ isError: true });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "call-1", subject: "tool-call" }),
    );

    const vetResult = await tools
      .get("mcp_vet")
      ?.execute(
        "call-2" as never,
        { name: "docs", transport: "http" } as never,
      );
    expect(vetResult).toMatchObject({ details: evidence });
    expect(vet).toHaveBeenCalledWith({ name: "docs", transport: "http" });
  });

  test("handles permit usage, success, and engine failure", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(decision("allow"))
      .mockResolvedValueOnce({ ok: false, code: "engine-unavailable" });
    const registered = register(evaluate, async () => evidence);
    const permit = registered.commands.get("permit");
    if (!permit) throw new Error("permit command missing");

    const usageContext = commandContext();
    await permit.handler("", usageContext as never);
    expect(usageContext.ui.notify).toHaveBeenCalledWith(
      "Usage: /permit <tool-name>",
      "error",
    );

    await permit.handler("read", commandContext() as never);
    expect(registered.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Trust Decision"),
    );

    const failureContext = commandContext();
    await permit.handler("write", failureContext as never);
    expect(failureContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed closed"),
      "error",
    );
  });

  test("handles MCP vet validation, evidence, and engine failure", async () => {
    const vet = vi
      .fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce({ ok: false, code: "engine-invalid" });
    const registered = register(async () => decision("allow"), vet);
    const command = registered.commands.get("mcp-vet");
    if (!command) throw new Error("mcp-vet command missing");

    const invalidContext = commandContext();
    await command.handler("not-json", invalidContext as never);
    expect(invalidContext.ui.notify).toHaveBeenCalledWith(
      "The MCP descriptor is not valid JSON.",
      "error",
    );

    await command.handler(
      JSON.stringify({ name: "docs", transport: "http" }),
      commandContext() as never,
    );
    expect(registered.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Vet Evidence"),
    );

    const failureContext = commandContext();
    await command.handler(
      JSON.stringify({ name: "docs", transport: "http" }),
      failureContext as never,
    );
    expect(failureContext.ui.notify).toHaveBeenCalledWith(
      "MCP vet failed with code engine-invalid.",
      "error",
    );
  });
});
