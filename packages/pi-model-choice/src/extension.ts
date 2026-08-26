import { Type } from "typebox";
import type { HostExtensionAPI } from "./host.ts";
import { runModelChoice } from "./runner.ts";
import type { ModelChoiceRequest, ModelChoiceResult } from "./types.ts";

const taskSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("budget"),
  Type.Literal("coding"),
  Type.Literal("fast"),
  Type.Literal("long-context"),
  Type.Literal("review"),
  Type.Literal("vision"),
]);

const requestSchema = Type.Object(
  {
    task: taskSchema,
    filter: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    weights: Type.Optional(
      Type.Object(
        {
          speed: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          price: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          context: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const resultText = (result: ModelChoiceResult): string =>
  result.ok
    ? JSON.stringify(result.selection)
    : `Model selection failed with code ${result.code}. Install a model-picker release that supports model-picker.selection v1 or set PI_MODEL_PICKER_BIN to its absolute launcher path.`;

export default function modelChoiceExtension(api: HostExtensionAPI): void {
  api.registerTool({
    name: "model_choice",
    label: "Choose model",
    description:
      "Request a versioned recommendation from the external model-picker CLI. Does not change the active model.",
    parameters: requestSchema,
    approval: "exec",
    loadMode: "discoverable",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runModelChoice(api, params, ctx.cwd);
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: result,
        ...(!result.ok ? { isError: true } : {}),
      };
    },
  });

  api.registerCommand("model-choice", {
    description:
      "Recommend a model for agent, coding, review, vision, budget, long-context, or fast work.",
    async handler(args, ctx) {
      const task = args.trim() || "agent";
      const request = { task } as ModelChoiceRequest;
      const result = await runModelChoice(api, request, ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(resultText(result), "error");
        return;
      }
      api.sendUserMessage(
        `Model-picker returned this versioned recommendation data:\n\n\`\`\`json\n${JSON.stringify(
          result.selection,
          null,
          2,
        )}\n\`\`\`\n\nTreat it as advisory data; do not switch models without the user's instruction.`,
      );
    },
  });
}
