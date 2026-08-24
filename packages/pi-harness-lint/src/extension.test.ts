import { describe, expect, test, vi } from "vitest";
import harnessLintExtension from "./extension.ts";

const context = { cwd: "/workspace", ui: { notify: vi.fn() } };

type Tool = {
  execute(
    id: string,
    params: { descriptor: unknown },
  ): Promise<{
    content: readonly { text: string }[];
    details: unknown;
    isError?: boolean;
  }>;
};

const load = () => {
  let tool: Tool | undefined;
  let command:
    | ((args: string, ctx: typeof context) => Promise<void> | void)
    | undefined;
  const sendUserMessage = vi.fn();
  harnessLintExtension({
    registerTool(value) {
      tool = value as unknown as Tool;
    },
    registerCommand(_name, options) {
      command = options.handler;
    },
    sendUserMessage,
  });
  return {
    get tool() {
      return tool;
    },
    get command() {
      return command;
    },
    sendUserMessage,
  };
};

describe("harnessLintExtension", () => {
  test("returns host-compatible report content", async () => {
    const loaded = load();
    if (!loaded.tool) throw new Error("tool not registered");
    const result = await loaded.tool.execute("call-1", {
      descriptor: {
        version: 1,
        name: "observer",
        approvalMode: "ask",
        tools: [],
      },
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      subject: "agent-harness",
      grade: "A",
    });
  });

  test("validates command JSON before sending report data", async () => {
    const loaded = load();
    if (!loaded.command) throw new Error("command not registered");
    await loaded.command("", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Usage: /harness-lint <descriptor-json>",
      "error",
    );
    await loaded.command('{"invalid"', context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(
      "The harness descriptor is not valid JSON.",
      "error",
    );

    await loaded.command(
      JSON.stringify({
        version: 1,
        name: "observer",
        approvalMode: "ask",
        tools: [],
      }),
      context,
    );
    expect(loaded.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("agent-harness"),
    );
  });
});
