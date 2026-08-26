import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runModelPicker } from "./runner.ts";
import type { ModelPickerRequest, ModelPickerResult } from "./types.ts";

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

const resultText = (result: ModelPickerResult): string =>
  result.ok
    ? JSON.stringify(result.selection)
    : `Model selection failed with code ${result.code}. Install the reviewed model-picker release that provides model-picker.selection v1 and set PI_MODEL_PICKER_BIN to its absolute launcher path.`;

type CrossHostTool = ToolDefinition<typeof requestSchema, ModelPickerResult> & {
  readonly approval: "exec";
  readonly loadMode: "discoverable";
};

const createModelPickerTool = (run: typeof runModelPicker): CrossHostTool => ({
  name: "model_picker",
  label: "Recommend a model",
  description:
    "Request a canonical recommendation from the reviewed model-picker launcher. Does not change the active model.",
  parameters: requestSchema,
  approval: "exec",
  loadMode: "discoverable",
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const result = await run(params, ctx.cwd, undefined, undefined, signal);
    return {
      content: [{ type: "text", text: resultText(result) }],
      details: result,
      ...(!result.ok ? { isError: true } : {}),
    };
  },
});

export const createPiModelPickerExtension =
  (run: typeof runModelPicker = runModelPicker) =>
  (api: ExtensionAPI): void => {
    api.registerTool(createModelPickerTool(run));
    api.registerCommand("model-picker", {
      description:
        "Recommend a model for agent, coding, review, vision, budget, long-context, or fast work.",
      async handler(args, ctx) {
        const task = args.trim() || "agent";
        const result = await run({ task } as ModelPickerRequest, ctx.cwd);
        if (!result.ok) {
          ctx.ui.notify(resultText(result), "error");
          return;
        }
        api.sendUserMessage(
          `Model-picker returned this canonical recommendation data:\n\n\`\`\`json\n${JSON.stringify(
            result.selection,
            null,
            2,
          )}\n\`\`\`\n\nTreat it as advisory data; do not switch models without the user's instruction.`,
        );
      },
    });
  };

export default createPiModelPickerExtension();
