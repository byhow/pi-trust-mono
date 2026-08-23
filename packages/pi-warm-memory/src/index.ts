import { Type as t } from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseArchiveArgs,
  validateArchiveDraft,
} from "./commands/archive-core.ts";
import { runRecall } from "./commands/recall-core.ts";
import { gatherGitContext } from "./git-context.ts";
import type { HostCommandContext, HostToolDefinition } from "./host.ts";
import {
  ALLOW_GIT_TRACKING_ENV,
  HISTORY_DIR_ENV,
  resolveHistoryLocation,
} from "./paths.ts";
import { persistArchive } from "./storage.ts";
import { buildArchivePrompt } from "./commands/archive-core.ts";

export const archiveToolParams = t.Object({
  packetKind: t.Union([t.Literal("handoff"), t.Literal("checkpoint")]),
  topic: t.String(),
  summary: t.String(),
  tags: t.Array(t.String()),
  files: t.Array(t.String()),
  nextStep: t.String(),
  goal: t.Optional(t.String()),
  decisions: t.Array(t.String()),
  commands: t.Array(t.String()),
  blockers: t.Array(t.String()),
  openQuestions: t.Array(t.String()),
  changes: t.Array(t.String()),
  risk: t.Optional(t.String()),
  pendingDecisions: t.Array(t.String()),
});

export const warmMemoryArchiveTool: HostToolDefinition<
  typeof archiveToolParams,
  unknown
> = {
  name: "warm_memory_archive",
  label: "Archive session",
  description:
    "Writes a handoff or checkpoint packet to the warm-memory episodic archive and append-only index.",
  parameters: archiveToolParams,
  approval: "write",
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    const hostCtx = ctx as HostCommandContext;
    const sessionId = hostCtx.sessionManager.getSessionId();
    if (!hostCtx.sessionManager.getSessionFile?.()) {
      return {
        status: "error",
        error: "/archive-session requires a persisted session.",
      };
    }

    const validation = validateArchiveDraft(params);
    if (!validation.ok) {
      return {
        status: "error",
        error:
          "Draft validation failed. Ensure required fields are single lines, arrays use bounds, and no credentials or secret-bearing arguments are copied. Provide a safe summary and try again.",
      };
    }

    const location = resolveHistoryLocation(
      ctx.cwd,
      process.env[HISTORY_DIR_ENV],
    );
    const git = await gatherGitContext(
      async () => ({ code: 1, killed: false, stdout: "" }),
      ctx.cwd,
    );

    const result = await persistArchive(
      location,
      sessionId,
      new Date().toISOString(),
      git.repoName,
      process.env[ALLOW_GIT_TRACKING_ENV],
      validation.value,
    );

    if (result.status === "success") {
      return {
        status: "success",
        data: `Successfully archived session. The packet is available at ${result.locator}.`,
      };
    }

    return {
      status: "error",
      error: `Failed to archive: ${result.status}`,
    };
  },
};

const archiveSession = async (
  api: ExtensionAPI,
  args: string,
  ctx: HostCommandContext,
): Promise<void> => {
  const { packetKind, instruction } = parseArchiveArgs(
    args.trim() ? args.trim().split(/\s+/) : [],
  );
  const sessionId = ctx.sessionManager.getSessionId();
  if (!ctx.sessionManager.getSessionFile?.()) {
    ctx.ui.notify("/archive-session requires a persisted session.", "error");
    return;
  }

  const git = await gatherGitContext(
    (command, commandArgs, options) => api.exec(command, commandArgs, options),
    ctx.cwd,
  );

  api.sendUserMessage(
    buildArchivePrompt({
      packetKind,
      instruction,
      sessionId,
      timestamp: new Date().toISOString(),
      git,
      template: `# ${packetKind === "handoff" ? "Handoff" : "Checkpoint"}\n- Topic:\n- Summary:\n- Tags:\n- Files:\n- Next Step:\n`,
    }),
  );
};

const recall = async (
  api: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const location = resolveHistoryLocation(
    ctx.cwd,
    process.env[HISTORY_DIR_ENV],
  );
  api.sendUserMessage(
    await runRecall(args.trim() ? args.trim().split(/\s+/) : [], location.path),
  );
};

export default function warmMemoryExtension(api: ExtensionAPI): void {
  // @ts-expect-error TypeBox vs omptype schemas diverge statically but unify dynamically.
  api.registerTool(warmMemoryArchiveTool);

  api.registerCommand("archive-session", {
    description:
      "Archive the current session as a handoff or checkpoint packet.",
    handler: async (args, ctx) =>
      archiveSession(api, args, ctx as HostCommandContext),
  });
  api.registerCommand("recall", {
    description:
      "Search prior handoff/checkpoint packets and surface the most relevant.",
    handler: async (args, ctx) => recall(api, args, ctx),
  });
}
