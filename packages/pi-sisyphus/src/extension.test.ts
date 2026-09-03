import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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

const temporaryDirectories: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();

const setEnvironment = (key: string, value: string): void => {
  if (!originalEnvironment.has(key)) {
    originalEnvironment.set(key, process.env[key]);
  }
  process.env[key] = value;
};

afterEach(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true })),
  );
});

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

  test("does not expose receipt minting through the public policy helper", async () => {
    const evaluated = decision("allow");
    const evaluate = vi.fn(async () => evaluated);
    const attestor = {
      record: vi.fn(async (): Promise<"recorded"> => "recorded"),
    };
    const publicHandlerFactory = createToolPolicyHandler as unknown as (
      evaluator: typeof evaluate,
      ignoredAttestor: typeof attestor,
    ) => ReturnType<typeof createToolPolicyHandler>;

    await expect(
      publicHandlerFactory(evaluate, attestor)(event as never, context),
    ).resolves.toBeUndefined();
    expect(attestor.record).not.toHaveBeenCalled();
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

  test("fails closed when normalized policy input cannot be constructed", async () => {
    const malformed = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unreadable input");
        },
      },
    );
    const evaluate = vi.fn();

    await expect(
      createToolPolicyHandler(evaluate)(
        { ...event, input: malformed } as never,
        context,
      ),
    ).resolves.toEqual({
      block: true,
      reason: "Policy enforcement failed closed (engine-unavailable).",
    });
    expect(evaluate).not.toHaveBeenCalled();
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
type RegisteredEventHandler = (
  event: never,
  context: never,
) => Promise<unknown>;

const register = (
  evaluate: (input: never) => Promise<TrustEvaluation>,
  vet: (descriptor: never) => Promise<McpVetResult>,
) => {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events: string[] = [];
  const eventHandlers = new Map<string, RegisteredEventHandler>();
  const sendUserMessage = vi.fn();
  createPiSisyphusExtension({
    evaluate: evaluate as never,
    vet: vet as never,
  })({
    on(name: string, handler: RegisteredEventHandler) {
      events.push(name);
      eventHandlers.set(name, handler);
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    sendUserMessage,
  } as never);
  return { commands, eventHandlers, events, sendUserMessage, tools };
};

const commandContext = () => ({
  cwd: "/work",
  ui: { notify: vi.fn() },
});

const armRealCanaryEngine = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sisyphus-extension-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "sy");
  const workspace = join(directory, "workspace");
  const receiptDir = join(directory, "receipts");
  const allowed = decision("allow");
  if (!allowed.ok) throw new Error("allow fixture is invalid");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(receiptDir, { mode: 0o700 });
  await writeFile(join(workspace, "README.md"), "public canary\n", "utf8");
  await writeFile(
    binary,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify(allowed.decision)}'\n`,
    "utf8",
  );
  await chmod(binary, 0o755);
  const environment = {
    PI_SISYPHUS_BIN: binary,
    PI_SISYPHUS_BUNDLE_DIR: join(directory, "bundle"),
    PI_SISYPHUS_BUNDLE_DIGEST: "a".repeat(64),
    PI_SISYPHUS_CANARY_MODE: "fleet-lab-v1",
    PI_SISYPHUS_CANARY_ACTION: "read-only-scout",
    PI_SISYPHUS_CANARY_CHALLENGE: "c".repeat(43),
    PI_SISYPHUS_CANARY_RECEIPT_DIR: receiptDir,
    PI_SISYPHUS_CANARY_POLICY_ID: "sisyphus://bundle/v1",
  };
  for (const [key, value] of Object.entries(environment)) {
    setEnvironment(key, value);
  }
  return { receiptDir, workspace };
};

describe("actual tool-call canary attestation", () => {
  test("uses the real Sisyphus evaluation path before recording", async () => {
    const { receiptDir, workspace } = await armRealCanaryEngine();
    const injectedEvaluate = vi.fn(async () => decision("deny"));
    const registered = register(injectedEvaluate, async () => evidence);
    const handler = registered.eventHandlers.get("tool_call");
    if (!handler) throw new Error("tool_call handler missing");

    await expect(
      handler(event as never, { cwd: workspace } as never),
    ).resolves.toBeUndefined();
    expect(injectedEvaluate).not.toHaveBeenCalled();
    const receipts = await readdir(receiptDir);
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(
      await readFile(join(receiptDir, receipts[0] ?? "missing"), "utf8"),
    );
    expect(receipt).toMatchObject({ result: "decision", effect: "allow" });
  });

  test("blocks an allowed call when the private receipt cannot be published", async () => {
    const { receiptDir, workspace } = await armRealCanaryEngine();
    await chmod(receiptDir, 0o755);
    const registered = register(
      async () => decision("allow"),
      async () => evidence,
    );
    const handler = registered.eventHandlers.get("tool_call");
    if (!handler) throw new Error("tool_call handler missing");

    await expect(
      handler(event as never, { cwd: workspace } as never),
    ).resolves.toEqual({
      block: true,
      reason: "Canary attestation failed closed (sink-invalid).",
    });
    await expect(readdir(receiptDir)).resolves.toEqual([]);
  });

  test("never records hypothetical tools, permit commands, or MCP vetting", async () => {
    const { receiptDir, workspace } = await armRealCanaryEngine();
    const registered = register(
      async () => decision("allow"),
      async () => evidence,
    );

    await registered.tools
      .get("sisyphus_policy")
      ?.execute(
        "call-1" as never,
        { toolName: "read", input: { path: "README.md" } } as never,
        undefined as never,
        undefined as never,
        { cwd: workspace } as never,
      );
    await registered.commands
      .get("permit")
      ?.handler("read", commandContext() as never);
    await registered.tools
      .get("mcp_vet")
      ?.execute(
        "call-2" as never,
        { name: "docs", transport: "http" } as never,
      );
    await registered.commands
      .get("mcp-vet")
      ?.handler(
        JSON.stringify({ name: "docs", transport: "http" }),
        commandContext() as never,
      );

    await expect(readdir(receiptDir)).resolves.toEqual([]);
  });
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
    expect(policyResult?.details).toEqual(decision("deny"));
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
