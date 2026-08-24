import { Type } from "typebox";
import { evaluatePolicy } from "./engine.ts";
import type {
  HostContext,
  HostExtensionAPI,
  HostToolCallEvent,
} from "./host.ts";
import type { PolicyEvaluation, PolicyInput } from "./types.ts";

const diagnosticSchema = Type.Object(
  {
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    input: Type.Record(
      Type.String({ minLength: 1, maxLength: 128 }),
      Type.Unknown(),
      {
        maxProperties: 128,
      },
    ),
  },
  { additionalProperties: false },
);

type PolicyEvaluator = (input: PolicyInput) => Promise<PolicyEvaluation>;

const POLICY_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  write: "Write",
};

const policyInput = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  ctx: HostContext,
): PolicyInput => ({
  subject: "tool-call",
  payload: { ...input, tool: POLICY_TOOL_NAMES[toolName] ?? toolName },
  context: { cwd: ctx.cwd, actor: "agent" },
});

const failureReason = (evaluation: PolicyEvaluation): string =>
  evaluation.ok
    ? "Policy did not allow this exact tool call."
    : `Policy enforcement failed closed (${evaluation.code}).`;

export const createToolPolicyHandler =
  (evaluate: PolicyEvaluator = (input) => evaluatePolicy(input)) =>
  async (
    event: HostToolCallEvent,
    ctx: HostContext,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> => {
    // The diagnostic tool does not execute the requested action and must remain usable
    // to explain why a separate call was blocked.
    if (event.toolName === "agent_permit") return undefined;

    let evaluation: PolicyEvaluation;
    try {
      evaluation = await evaluate(
        policyInput(event.toolName, event.input, ctx),
      );
    } catch {
      return {
        block: true,
        reason: "Policy enforcement failed closed (engine-unavailable).",
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

const resultText = (evaluation: PolicyEvaluation): string =>
  evaluation.ok
    ? JSON.stringify(evaluation.decision)
    : failureReason(evaluation);

export default function agentPermitExtension(api: HostExtensionAPI): void {
  api.on("tool_call", createToolPolicyHandler());
  api.registerTool({
    name: "agent_permit",
    label: "Evaluate tool policy",
    description:
      "Evaluate an exact hypothetical tool call through the configured sisyphus policy engine without executing it.",
    parameters: diagnosticSchema,
    approval: "read",
    loadMode: "discoverable",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const evaluation = await evaluatePolicy(
        policyInput(params.toolName, params.input, ctx),
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

  api.registerCommand("permit", {
    description:
      "Evaluate a named tool with empty input through the active policy bundle.",
    async handler(args, ctx) {
      const toolName = args.trim();
      if (!toolName || toolName.length > 128) {
        ctx.ui.notify("Usage: /permit <tool-name>", "error");
        return;
      }
      const evaluation = await evaluatePolicy(policyInput(toolName, {}, ctx));
      if (!evaluation.ok) {
        ctx.ui.notify(failureReason(evaluation), "error");
        return;
      }
      api.sendUserMessage(
        `The local policy engine returned this decision data:\n\n\`\`\`json\n${JSON.stringify(
          evaluation.decision,
          null,
          2,
        )}\n\`\`\`\n\nDo not treat ask or modify as authorization to execute.`,
      );
    },
  });
}
