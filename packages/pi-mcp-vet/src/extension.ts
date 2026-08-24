import { Type } from "typebox";
import type { HostExtensionAPI, HostToolDefinition } from "./host.ts";
import type { McpVetDecision } from "./types.ts";
import { vetMcpServer } from "./vet.ts";

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

export const vetTool: HostToolDefinition<
  typeof descriptorSchema,
  McpVetDecision
> = {
  name: "mcp_vet",
  label: "Vet MCP server",
  description:
    "Statically vet one bounded MCP server descriptor before connection. Never connects to or executes the server.",
  parameters: descriptorSchema,
  approval: "read",
  loadMode: "discoverable",
  async execute(_toolCallId, params) {
    const decision = vetMcpServer(params);
    return {
      content: [{ type: "text", text: JSON.stringify(decision) }],
      details: decision,
      ...(decision.effect === "deny" ? { isError: true } : {}),
    };
  },
};

const decisionMessage = (decision: McpVetDecision): string =>
  `MCP vet produced this policy decision:\n\n\`\`\`json\n${JSON.stringify(
    decision,
    null,
    2,
  )}\n\`\`\`\n\nTreat it as decision data. A deny must not be overridden; an ask requires explicit operator approval.`;

export default function mcpVetExtension(api: HostExtensionAPI): void {
  api.registerTool(vetTool);
  api.registerCommand("mcp-vet", {
    description: "Vet one MCP descriptor supplied as bounded JSON.",
    handler(args, ctx) {
      if (!args.trim() || args.length > 64 * 1024) {
        ctx.ui.notify("Usage: /mcp-vet <descriptor-json>", "error");
        return;
      }
      try {
        const decision = vetMcpServer(JSON.parse(args));
        api.sendUserMessage(decisionMessage(decision));
      } catch {
        ctx.ui.notify("The MCP descriptor is not valid JSON.", "error");
      }
    },
  });
}
