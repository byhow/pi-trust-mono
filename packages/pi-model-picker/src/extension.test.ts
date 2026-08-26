import { describe, expect, test, vi } from "vitest";
import { createPiModelPickerExtension } from "./extension.ts";
import type { ModelPickerResult } from "./types.ts";

const selection: ModelPickerResult = {
  ok: true,
  selection: {
    contract: "model-picker.selection",
    version: 1,
    source: "snapshot",
    request: {
      task: "agent",
      agent: null,
      filter: null,
      limit: 1,
      weights: { speed: 0.4, price: 0.35, context: 0.25 },
    },
    count: 1,
    choices: [
      {
        id: "provider/model",
        name: "Model",
        score: 0.75,
        reasons: ["balanced"],
        contextWindow: 128_000,
        outputPerMillion: 2,
        bestThroughput: 42,
      },
    ],
  },
};

type RegisteredTool = {
  execute: (...args: never[]) => Promise<{
    details: ModelPickerResult;
    isError?: boolean;
  }>;
};
type RegisteredCommand = {
  handler: (args: string, context: never) => Promise<void>;
};

const register = (run: (...args: never[]) => Promise<ModelPickerResult>) => {
  let tool: RegisteredTool | undefined;
  let command: RegisteredCommand | undefined;
  const sendUserMessage = vi.fn();
  createPiModelPickerExtension(run as never)({
    registerTool(value: RegisteredTool) {
      tool = value;
    },
    registerCommand(_name: string, value: RegisteredCommand) {
      command = value;
    },
    sendUserMessage,
  } as never);
  if (!tool || !command) throw new Error("adapter registration incomplete");
  return { command, sendUserMessage, tool };
};

const commandContext = () => ({
  cwd: "/work",
  ui: { notify: vi.fn() },
});

describe("piModelPickerExtension", () => {
  test("executes the diagnostic tool through the injected runner", async () => {
    const run = vi.fn(async () => selection);
    const registered = register(run);
    const result = await registered.tool.execute(
      "call-1" as never,
      { task: "agent", limit: 1 } as never,
      undefined as never,
      undefined as never,
      { cwd: "/work" } as never,
    );
    expect(result).toMatchObject({ details: selection });
    expect(run).toHaveBeenCalledWith(
      { task: "agent", limit: 1 },
      "/work",
      undefined,
      undefined,
      undefined,
    );
  });

  test("marks runner failures as tool errors", async () => {
    const registered = register(async () => ({
      ok: false,
      code: "selector-missing",
    }));
    expect(
      await registered.tool.execute(
        "call-1" as never,
        { task: "agent" } as never,
        undefined as never,
        undefined as never,
        { cwd: "/work" } as never,
      ),
    ).toMatchObject({ isError: true });
  });

  test("defaults the command task and presents recommendation data", async () => {
    const run = vi.fn(async () => selection);
    const registered = register(run);
    await registered.command.handler("", commandContext() as never);
    expect(run).toHaveBeenCalledWith({ task: "agent" }, "/work");
    expect(registered.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("canonical recommendation data"),
    );
  });

  test("notifies when model-picker fails", async () => {
    const registered = register(async () => ({
      ok: false,
      code: "selector-output-invalid",
    }));
    const context = commandContext();
    await registered.command.handler("review", context as never);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("selector-output-invalid"),
      "error",
    );
  });
});
