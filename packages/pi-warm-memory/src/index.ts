import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  ARCHIVE_LIMITS,
  buildArchivePrompt,
  parseArchiveArgs,
  TEMPLATE_FILE,
  validateArchiveDraft,
} from "./commands/archive-core.ts";
import { runRecall } from "./commands/recall-core.ts";
import { gatherGitContext } from "./git-context.ts";
import type {
  HostContext,
  HostExtensionAPI,
  HostToolDefinition,
} from "./host.ts";
import {
  ALLOW_GIT_TRACKING_ENV,
  HISTORY_DIR_ENV,
  resolveHistoryLocation,
} from "./paths.ts";
import { persistArchive } from "./storage.ts";

const archiveToolParams = Type.Object(
  {
    packetKind: Type.Union([
      Type.Literal("handoff"),
      Type.Literal("checkpoint"),
    ]),
    topic: Type.String({ minLength: 1, maxLength: ARCHIVE_LIMITS.topic }),
    summary: Type.String({ minLength: 1, maxLength: ARCHIVE_LIMITS.summary }),
    tags: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: ARCHIVE_LIMITS.tags,
    }),
    files: Type.Array(
      Type.String({ minLength: 1, maxLength: ARCHIVE_LIMITS.item }),
      { maxItems: ARCHIVE_LIMITS.files },
    ),
    nextStep: Type.String({ minLength: 1, maxLength: ARCHIVE_LIMITS.text }),
    goal: Type.Optional(Type.String({ maxLength: ARCHIVE_LIMITS.text })),
    decisions: Type.Array(Type.String({ maxLength: ARCHIVE_LIMITS.item }), {
      maxItems: ARCHIVE_LIMITS.items,
    }),
    commands: Type.Array(Type.String({ maxLength: ARCHIVE_LIMITS.item }), {
      maxItems: ARCHIVE_LIMITS.items,
    }),
    blockers: Type.Array(Type.String({ maxLength: ARCHIVE_LIMITS.item }), {
      maxItems: ARCHIVE_LIMITS.items,
    }),
    openQuestions: Type.Array(Type.String({ maxLength: ARCHIVE_LIMITS.item }), {
      maxItems: ARCHIVE_LIMITS.items,
    }),
    changes: Type.Array(Type.String({ maxLength: ARCHIVE_LIMITS.item }), {
      maxItems: ARCHIVE_LIMITS.items,
    }),
    risk: Type.Optional(Type.String({ maxLength: ARCHIVE_LIMITS.text })),
    pendingDecisions: Type.Array(
      Type.String({ maxLength: ARCHIVE_LIMITS.item }),
      { maxItems: ARCHIVE_LIMITS.items },
    ),
  },
  { additionalProperties: false },
);

type ArchiveToolDetails = {
  readonly status: "success" | "error";
  readonly locator?: string;
};

type CrossHostArchiveTool = HostToolDefinition<
  typeof archiveToolParams,
  ArchiveToolDetails
>;

const textResult = (
  text: string,
  details: ArchiveToolDetails,
  isError = false,
) => ({
  content: [{ type: "text" as const, text }],
  details,
  ...(isError ? { isError: true } : {}),
});

export const warmMemoryArchiveTool: CrossHostArchiveTool = {
  name: "warm_memory_archive",
  label: "Archive session",
  description:
    "Persist one validated handoff or checkpoint packet. Use only when /archive-session asks for it.",
  parameters: archiveToolParams,
  approval: "write",
  loadMode: "essential",
  async execute(_callId, params, _signal, _onUpdate, ctx) {
    if (!ctx.sessionManager.getSessionFile()) {
      return textResult(
        "Warm-memory requires a persisted session.",
        { status: "error" },
        true,
      );
    }

    const validation = validateArchiveDraft(params);
    if (!validation.ok) {
      return textResult(
        "The packet was not stored. Remove secrets and provide bounded, single-line structured fields.",
        { status: "error" },
        true,
      );
    }

    try {
      const location = resolveHistoryLocation(
        ctx.cwd,
        process.env[HISTORY_DIR_ENV],
      );
      const result = await persistArchive(
        location,
        ctx.sessionManager.getSessionId(),
        new Date().toISOString(),
        basename(ctx.cwd) || "project",
        process.env[ALLOW_GIT_TRACKING_ENV],
        validation.value,
      );
      if (result.status === "success") {
        return textResult(`Stored warm-memory packet at ${result.locator}.`, {
          status: "success",
          locator: result.locator,
        });
      }
    } catch {
      // The model receives a stable, secret-safe failure below.
    }

    return textResult(
      "The packet was not stored because the private archive is unavailable or unsafe.",
      { status: "error" },
      true,
    );
  },
};

const splitCommandArguments = (args: string): readonly string[] =>
  args.trim() ? args.trim().split(/\s+/) : [];

const archiveSession = async (
  api: HostExtensionAPI,
  args: string,
  ctx: HostContext,
): Promise<void> => {
  if (!ctx.sessionManager.getSessionFile()) {
    ctx.ui.notify("/archive-session requires a persisted session.", "error");
    return;
  }

  const { packetKind, instruction } = parseArchiveArgs(
    splitCommandArguments(args),
  );
  const moduleRoot = resolve(
    dirname(await realpath(fileURLToPath(import.meta.url))),
    "..",
  );
  const template = await readFile(
    resolve(moduleRoot, "templates", TEMPLATE_FILE[packetKind]),
    "utf8",
  );
  const git = await gatherGitContext(
    (command, commandArgs, options) => api.exec(command, commandArgs, options),
    ctx.cwd,
  );

  api.sendUserMessage(
    buildArchivePrompt({
      packetKind,
      instruction,
      sessionId: ctx.sessionManager.getSessionId(),
      timestamp: new Date().toISOString(),
      git,
      template,
    }),
  );
};

const recall = async (
  api: HostExtensionAPI,
  args: string,
  ctx: HostContext,
): Promise<void> => {
  try {
    const location = resolveHistoryLocation(
      ctx.cwd,
      process.env[HISTORY_DIR_ENV],
    );
    api.sendUserMessage(
      await runRecall(splitCommandArguments(args), location.path),
    );
  } catch {
    ctx.ui.notify(
      "The configured warm-memory archive path is unsafe.",
      "error",
    );
  }
};

/** Register only the shared public extension primitives supported by both hosts. */
export default function warmMemoryExtension(api: HostExtensionAPI): void {
  api.registerTool(warmMemoryArchiveTool);
  api.registerCommand("archive-session", {
    description:
      "Archive the current session as a handoff or checkpoint packet. Usage: /archive-session [checkpoint] <instruction>",
    handler: async (args, ctx) => archiveSession(api, args, ctx),
  });
  api.registerCommand("recall", {
    description:
      "Search prior handoff/checkpoint packets. Usage: /recall <query> [--tags a,b] [--since YYYY-MM-DD] [--kind handoff|checkpoint]",
    handler: async (args, ctx) => recall(api, args, ctx),
  });
}
