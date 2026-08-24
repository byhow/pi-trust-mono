import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import warmMemoryExtension from "./index.ts";
import { HISTORY_DIR_ENV } from "./paths.ts";

const originalHistoryDir = process.env[HISTORY_DIR_ENV];

type RegisteredCommand = {
  handler: (args: string, ctx: never) => Promise<void>;
};
beforeEach(() => {
  delete process.env[HISTORY_DIR_ENV];
});

afterEach(() => {
  if (originalHistoryDir === undefined) delete process.env[HISTORY_DIR_ENV];
  else process.env[HISTORY_DIR_ENV] = originalHistoryDir;
});

const loadCommands = () => {
  const commands = new Map<string, RegisteredCommand>();
  const sendUserMessage = vi.fn();
  warmMemoryExtension({
    registerCommand(name: string, options: RegisteredCommand) {
      commands.set(name, options);
    },
    registerTool: vi.fn(),
    sendUserMessage,
    exec: async () => ({ code: 1, killed: false, stdout: "" }),
  } as never);
  return { commands, sendUserMessage };
};

const commandContext = (cwd: string, persisted = false) =>
  ({
    cwd,
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: persisted ? () => "/tmp/session.jsonl" : undefined,
    },
    ui: { notify: vi.fn() },
  }) as never;

const getCommand = (
  commands: Map<string, RegisteredCommand>,
  name: string,
): RegisteredCommand => {
  const command = commands.get(name);
  if (!command) throw new Error(`Expected /${name} to be registered.`);
  return command;
};

describe("warmMemoryExtension", () => {
  test("registers both manifest command names", () => {
    const { commands } = loadCommands();
    expect([...commands.keys()]).toEqual(["archive-session", "recall"]);
  });

  test("recall sends generated text through sendUserMessage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-warm-extension-"));
    const { commands, sendUserMessage } = loadCommands();
    await getCommand(commands, "recall").handler(
      "auth",
      commandContext(cwd, true),
    );
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  test("uses inherited, relative, and absolute adapter configuration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-warm-extension-"));
    const { commands, sendUserMessage } = loadCommands();
    process.env[HISTORY_DIR_ENV] = "inherited/history";
    await getCommand(commands, "recall").handler(
      "auth",
      commandContext(cwd, true),
    );
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  test("archive sends the generated prompt through sendUserMessage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-warm-extension-"));
    const { commands, sendUserMessage } = loadCommands();
    await getCommand(commands, "archive-session").handler(
      "checkpoint preserve this state",
      commandContext(cwd, true),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "Archive this session as a **checkpoint** packet.",
      ),
    );
  });
});
