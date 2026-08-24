import { describe, expect, test, vi } from "vitest";
import mcpVetExtension, { vetTool } from "./extension.ts";

const context = {
  cwd: "/workspace",
  ui: { notify: vi.fn() },
};

describe("mcpVetExtension", () => {
  test("registers the shared tool and command names", () => {
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    mcpVetExtension({
      registerTool,
      registerCommand,
      sendUserMessage: vi.fn(),
    });
    expect(registerTool).toHaveBeenCalledWith(vetTool);
    expect(registerCommand).toHaveBeenCalledWith(
      "mcp-vet",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  test("returns a host-compatible read result", async () => {
    const result = await vetTool.execute(
      "call-1",
      {
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/rpc",
      },
      undefined,
      undefined,
      context,
    );
    expect(result.details.effect).toBe("allow");
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      subject: "mcp-connect",
    });
  });

  test("rejects missing and malformed command input without echoing it", async () => {
    let handler:
      | ((args: string, ctx: typeof context) => Promise<void> | void)
      | undefined;
    const sendUserMessage = vi.fn();
    mcpVetExtension({
      registerTool: vi.fn(),
      registerCommand(_name, options) {
        handler = options.handler;
      },
      sendUserMessage,
    });
    if (!handler) throw new Error("command was not registered");

    await handler("", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Usage: /mcp-vet <descriptor-json>",
      "error",
    );

    await handler('{"token":"secret"', context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(
      "The MCP descriptor is not valid JSON.",
      "error",
    );
    expect(sendUserMessage).not.toHaveBeenCalled();

    await handler(
      JSON.stringify({
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/rpc",
      }),
      context,
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining('"effect": "allow"'),
    );
  });
});
