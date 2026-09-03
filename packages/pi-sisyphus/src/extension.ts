import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CanaryAttestationError,
  createCanaryAttestor,
} from "./canary-attestor.ts";
import {
  evaluateTrust,
  evaluateTrustWithProvenance,
  type ProvenanceBoundTrustEvaluation,
} from "./engine.ts";
import { vetMcp } from "./mcp.ts";
import { classifyResourceScope } from "./resource-scope.ts";
import type {
  McpServerDescriptor,
  McpVetResult,
  TrustEvaluation,
  TrustInput,
} from "./types.ts";

const diagnosticSchema = Type.Object(
  {
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    input: Type.Record(
      Type.String({ minLength: 1, maxLength: 128 }),
      Type.Unknown(),
      { maxProperties: 128 },
    ),
  },
  { additionalProperties: false },
);

const stringMap = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.String({ minLength: 1, maxLength: 2_048 }),
  { maxProperties: 64 },
);

const descriptorSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    args: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
        maxItems: 64,
      }),
    ),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    env: Type.Optional(stringMap),
    headers: Type.Optional(stringMap),
    roots: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
        maxItems: 64,
      }),
    ),
    capabilities: Type.Optional(
      Type.Object(
        {
          readOnly: Type.Optional(Type.Boolean()),
          filesystem: Type.Optional(
            Type.Union([
              Type.Literal("none"),
              Type.Literal("workspace"),
              Type.Literal("host"),
            ]),
          ),
          network: Type.Optional(
            Type.Union([
              Type.Literal("none"),
              Type.Literal("loopback"),
              Type.Literal("internet"),
            ]),
          ),
          secrets: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    provenance: Type.Optional(
      Type.Object(
        {
          package: Type.Optional(Type.String({ maxLength: 128 })),
          version: Type.Optional(Type.String({ maxLength: 64 })),
          sha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const POLICY_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit",
  find: "Find",
  glob: "Glob",
  grep: "Grep",
  ls: "Ls",
  read: "Read",
  write: "Write",
};
const DIAGNOSTIC_TOOLS = new Set(["sisyphus_policy", "mcp_vet"]);

const policyInput = async (
  requestId: string,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<TrustInput> => {
  const policyTool = POLICY_TOOL_NAMES[toolName] ?? toolName;
  const resourceScope = await classifyResourceScope(policyTool, input, cwd);
  return {
    version: 1,
    requestId,
    subject: "tool-call",
    payload: { ...input, tool: policyTool, resourceScope },
    context: { cwd, actor: "agent" },
  };
};

const failureReason = (evaluation: TrustEvaluation): string =>
  evaluation.ok
    ? "Policy did not allow this exact tool call."
    : `Policy enforcement failed closed (${evaluation.code}).`;

export const createToolPolicyHandler =
  (evaluate: typeof evaluateTrust = evaluateTrust) =>
  async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    if (DIAGNOSTIC_TOOLS.has(event.toolName)) return undefined;
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Readonly<Record<string, unknown>>)
        : {};
    let evaluation: TrustEvaluation;
    try {
      evaluation = await evaluate(
        await policyInput(event.toolCallId, event.toolName, input, ctx.cwd),
      );
    } catch (error) {
      if (!(error instanceof CanaryAttestationError)) {
        return {
          block: true,
          reason: "Policy enforcement failed closed (engine-unavailable).",
        };
      }
      return {
        block: true,
        reason: `Canary attestation failed closed (${error.code}).`,
      };
    }
    if (evaluation.ok && evaluation.decision.effect === "allow")
      return undefined;
    if (!evaluation.ok) {
      return { block: true, reason: failureReason(evaluation) };
    }
    const prefix =
      evaluation.decision.effect === "ask"
        ? "Explicit operator approval is required"
        : evaluation.decision.effect === "modify"
          ? "Policy proposed a rewrite; resubmit the exact reviewed input"
          : "Policy denied this tool call";
    return {
      block: true,
      reason: `${prefix}: ${evaluation.decision.reason}`,
    };
  };

const publicEvaluation = (
  evaluation: ProvenanceBoundTrustEvaluation,
): TrustEvaluation =>
  evaluation.ok
    ? { ok: true, decision: evaluation.decision }
    : { ok: false, code: evaluation.code };

const createAttestedToolPolicyHandler = () => {
  const attestor = createCanaryAttestor();
  return createToolPolicyHandler(async (input) => {
    const evaluation = await evaluateTrustWithProvenance(input);
    await attestor.record(input, evaluation);
    return publicEvaluation(evaluation);
  });
};

const resultText = (evaluation: TrustEvaluation): string =>
  evaluation.ok
    ? JSON.stringify(evaluation.decision)
    : failureReason(evaluation);

const evidenceText = (result: McpVetResult): string =>
  result.ok
    ? JSON.stringify(result.evidence)
    : `MCP vet failed with code ${result.code}.`;

type PolicyTool = ToolDefinition<typeof diagnosticSchema, TrustEvaluation> & {
  readonly approval: "read";
  readonly loadMode: "discoverable";
};
type McpTool = ToolDefinition<typeof descriptorSchema, McpVetResult> & {
  readonly approval: "read";
  readonly loadMode: "discoverable";
};

const createPolicyTool = (evaluate: typeof evaluateTrust): PolicyTool => ({
  name: "sisyphus_policy",
  label: "Evaluate Sisyphus policy",
  description:
    "Evaluate an exact hypothetical tool call through the reviewed Sisyphus bundle without executing it.",
  parameters: diagnosticSchema,
  approval: "read",
  loadMode: "discoverable",
  async execute(toolCallId, params, _signal, _onUpdate, ctx) {
    const evaluation = await evaluate(
      await policyInput(toolCallId, params.toolName, params.input, ctx.cwd),
    );
    return {
      content: [{ type: "text", text: resultText(evaluation) }],
      details: evaluation,
      ...(!evaluation.ok || evaluation.decision.effect !== "allow"
        ? { isError: true }
        : {}),
    };
  },
});

const createMcpVetTool = (vet: typeof vetMcp): McpTool => ({
  name: "mcp_vet",
  label: "Vet MCP server",
  description:
    "Generate static Sisyphus evidence for one bounded MCP descriptor. Never connects to or executes the server.",
  parameters: descriptorSchema,
  approval: "read",
  loadMode: "discoverable",
  async execute(_toolCallId, params) {
    const result = await vet(params);
    return {
      content: [{ type: "text", text: evidenceText(result) }],
      details: result,
      ...(!result.ok ? { isError: true } : {}),
    };
  },
});

export const createPiSisyphusExtension =
  (
    services: {
      readonly evaluate?: typeof evaluateTrust;
      readonly vet?: typeof vetMcp;
    } = {},
  ) =>
  (api: ExtensionAPI): void => {
    const evaluate = services.evaluate ?? evaluateTrust;
    const vet = services.vet ?? vetMcp;
    api.on("tool_call", createAttestedToolPolicyHandler());
    api.registerTool(createPolicyTool(evaluate));
    api.registerTool(createMcpVetTool(vet));
    api.registerCommand("permit", {
      description:
        "Evaluate a named tool with empty input through the reviewed Sisyphus bundle.",
      async handler(args, ctx) {
        const toolName = args.trim();
        if (!toolName || toolName.length > 128) {
          ctx.ui.notify("Usage: /permit <tool-name>", "error");
          return;
        }
        const evaluation = await evaluate(
          await policyInput("permit-command", toolName, {}, ctx.cwd),
        );
        if (!evaluation.ok) {
          ctx.ui.notify(failureReason(evaluation), "error");
          return;
        }
        api.sendUserMessage(
          `Sisyphus returned this Trust Decision:\n\n\`\`\`json\n${JSON.stringify(
            evaluation.decision,
            null,
            2,
          )}\n\`\`\`\n\nOnly allow authorizes; ask and modify remain blocked.`,
        );
      },
    });
    api.registerCommand("mcp-vet", {
      description:
        "Generate Sisyphus Vet Evidence for one bounded MCP descriptor.",
      async handler(args, ctx) {
        if (!args.trim() || args.length > 64 * 1024) {
          ctx.ui.notify("Usage: /mcp-vet <descriptor-json>", "error");
          return;
        }
        let descriptor: McpServerDescriptor;
        try {
          descriptor = JSON.parse(args) as McpServerDescriptor;
        } catch {
          ctx.ui.notify("The MCP descriptor is not valid JSON.", "error");
          return;
        }
        const result = await vet(descriptor);
        if (!result.ok) {
          ctx.ui.notify(evidenceText(result), "error");
          return;
        }
        api.sendUserMessage(
          `Sisyphus returned this Vet Evidence:\n\n\`\`\`json\n${JSON.stringify(
            result.evidence,
            null,
            2,
          )}\n\`\`\`\n\nEvidence is advisory and never authorizes an MCP connection.`,
        );
      },
    });
  };

export default createPiSisyphusExtension();
