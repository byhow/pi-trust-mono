import { Type } from "typebox";
import type { HostExtensionAPI } from "./host.ts";
import { lintHarness } from "./lint.ts";

const lintSchema = Type.Object(
  { descriptor: Type.Unknown() },
  { additionalProperties: false },
);

export default function harnessLintExtension(api: HostExtensionAPI): void {
  api.registerTool({
    name: "harness_lint",
    label: "Lint harness",
    description:
      "Statically score one bounded agent-harness descriptor. Does not inspect live auth, settings, sessions, or credentials.",
    parameters: lintSchema,
    approval: "read",
    loadMode: "discoverable",
    async execute(_toolCallId, params) {
      const report = lintHarness(params.descriptor);
      const hasError = report.findings.some(
        (finding) => finding.severity === "error",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        details: report,
        ...(hasError ? { isError: true } : {}),
      };
    },
  });

  api.registerCommand("harness-lint", {
    description: "Lint one harness descriptor supplied as bounded JSON.",
    handler(args, ctx) {
      if (!args.trim() || args.length > 128 * 1024) {
        ctx.ui.notify("Usage: /harness-lint <descriptor-json>", "error");
        return;
      }
      try {
        const report = lintHarness(JSON.parse(args));
        api.sendUserMessage(
          `Harness lint produced this static report:\n\n\`\`\`json\n${JSON.stringify(
            report,
            null,
            2,
          )}\n\`\`\`\n\nTreat findings as review data; error findings block unattended rollout.`,
        );
      } catch {
        ctx.ui.notify("The harness descriptor is not valid JSON.", "error");
      }
    },
  });
}
