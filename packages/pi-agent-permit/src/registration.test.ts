import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import agentPermitExtension from "./extension.ts";
import type { HostContext, HostToolCallEvent } from "./host.ts";

const originalBundle = process.env.PI_TRUST_BUNDLE_DIR;
const originalBinary = process.env.PI_TRUST_ENGINE_BIN;

const context: HostContext = {
  cwd: "/workspace",
  ui: { notify: vi.fn() },
};

type RegisteredTool = {
  execute(
    id: string,
    params: { toolName: string; input: Record<string, unknown> },
    signal: undefined,
    update: undefined,
    ctx: HostContext,
  ): Promise<{
    content: readonly { text: string }[];
    details: unknown;
    isError?: boolean;
  }>;
};

beforeEach(() => {
  delete process.env.PI_TRUST_BUNDLE_DIR;
  delete process.env.PI_TRUST_ENGINE_BIN;
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalBundle === undefined) delete process.env.PI_TRUST_BUNDLE_DIR;
  else process.env.PI_TRUST_BUNDLE_DIR = originalBundle;
  if (originalBinary === undefined) delete process.env.PI_TRUST_ENGINE_BIN;
  else process.env.PI_TRUST_ENGINE_BIN = originalBinary;
});

const load = () => {
  let hook:
    | ((
        event: HostToolCallEvent,
        ctx: HostContext,
      ) => Promise<{ block?: boolean; reason?: string } | undefined>)
    | undefined;
  let tool: RegisteredTool | undefined;
  let command:
    | ((args: string, ctx: HostContext) => Promise<void> | void)
    | undefined;
  const sendUserMessage = vi.fn();

  agentPermitExtension({
    on(_event, handler) {
      hook = async (event, ctx) => await handler(event, ctx);
    },
    registerTool(value) {
      // Test boundary: the runtime schema already validates these parameters.
      tool = value as unknown as RegisteredTool;
    },
    registerCommand(_name, options) {
      command = options.handler;
    },
    sendUserMessage,
  });
  return {
    get hook() {
      return hook;
    },
    get tool() {
      return tool;
    },
    get command() {
      return command;
    },
    sendUserMessage,
  };
};

describe("agentPermitExtension", () => {
  test("registers a hook that blocks when policy configuration is absent", async () => {
    const loaded = load();
    if (!loaded.hook) throw new Error("hook not registered");
    expect(
      await loaded.hook(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "read",
          input: { path: "README.md" },
        },
        context,
      ),
    ).toEqual({
      block: true,
      reason: "Policy enforcement failed closed (policy-config-invalid).",
    });
  });

  test("keeps diagnostics non-executing and fail-closed", async () => {
    const loaded = load();
    if (!loaded.tool) throw new Error("tool not registered");
    const result = await loaded.tool.execute(
      "call-1",
      { toolName: "read", input: {} },
      undefined,
      undefined,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy-config-invalid");
  });

  test("validates the slash command before policy evaluation", async () => {
    const loaded = load();
    if (!loaded.command) throw new Error("command not registered");
    await loaded.command("", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Usage: /permit <tool-name>",
      "error",
    );

    await loaded.command("read", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(
      "Policy enforcement failed closed (policy-config-invalid).",
      "error",
    );
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
  });
});
