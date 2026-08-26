import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { selection } from "../test/selection-fixture.ts";
import modelChoiceExtension from "./extension.ts";

const originalBinary = process.env.PI_MODEL_PICKER_BIN;
beforeEach(() => {
  process.env.PI_MODEL_PICKER_BIN = "/opt/bin/model-picker";
});
afterEach(() => {
  if (originalBinary === undefined) delete process.env.PI_MODEL_PICKER_BIN;
  else process.env.PI_MODEL_PICKER_BIN = originalBinary;
});

const context = {
  cwd: "/workspace",
  ui: { notify: vi.fn() },
};

type RegisteredTool = {
  execute(
    id: string,
    params: { task: "agent"; limit?: number },
    signal: undefined,
    update: undefined,
    ctx: typeof context,
  ): Promise<{ content: readonly { text: string }[]; details: unknown }>;
};

const load = (stdout = JSON.stringify(selection)) => {
  let tool: RegisteredTool | undefined;
  let command:
    | ((args: string, ctx: typeof context) => Promise<void> | void)
    | undefined;
  const sendUserMessage = vi.fn();
  const exec = vi.fn(async () => ({ code: 0, killed: false, stdout }));
  modelChoiceExtension({
    registerTool(value) {
      tool = value as unknown as RegisteredTool;
    },
    registerCommand(_name, options) {
      command = options.handler;
    },
    sendUserMessage,
    exec,
  });
  return {
    get tool() {
      return tool;
    },
    get command() {
      return command;
    },
    sendUserMessage,
    exec,
  };
};

describe("modelChoiceExtension", () => {
  test("registers a host-compatible advisory tool", async () => {
    const loaded = load();
    if (!loaded.tool) throw new Error("tool not registered");
    const result = await loaded.tool.execute(
      "call-1",
      { task: "agent", limit: 1 },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      contract: "model-picker.selection",
      version: 1,
    });
  });

  test("sends validated selection data from the command", async () => {
    const loaded = load();
    if (!loaded.command) throw new Error("command not registered");
    await loaded.command("agent", context);
    expect(loaded.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("model-picker.selection"),
    );
  });

  test("fails safely for an unsupported command task", async () => {
    const loaded = load();
    if (!loaded.command) throw new Error("command not registered");
    await loaded.command("unknown", context);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("selector-invalid"),
      "error",
    );
    expect(loaded.sendUserMessage).not.toHaveBeenCalled();
  });
});
