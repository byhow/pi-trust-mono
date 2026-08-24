import type {
  HarnessDescriptor,
  HarnessLintFinding,
  HarnessLintReport,
  HarnessMcpDescriptor,
  HarnessToolDescriptor,
} from "./types.ts";

const MAX_ITEMS = 128;

const boundedText = (value: unknown, maxLength = 256): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return undefined;
  }
  return value;
};

const parseTool = (value: unknown): HarnessToolDescriptor | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<Record<keyof HarnessToolDescriptor, unknown>>;
  const name = boundedText(raw.name);
  if (
    !name ||
    (raw.effect !== "read" &&
      raw.effect !== "write" &&
      raw.effect !== "exec") ||
    (raw.sandboxed !== undefined && typeof raw.sandboxed !== "boolean") ||
    (raw.network !== undefined &&
      raw.network !== "none" &&
      raw.network !== "loopback" &&
      raw.network !== "internet")
  ) {
    return undefined;
  }
  return {
    name,
    effect: raw.effect,
    ...(raw.sandboxed !== undefined ? { sandboxed: raw.sandboxed } : {}),
    ...(raw.network !== undefined ? { network: raw.network } : {}),
  };
};

const parseMcp = (value: unknown): HarnessMcpDescriptor | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<Record<keyof HarnessMcpDescriptor, unknown>>;
  const name = boundedText(raw.name);
  if (!name || typeof raw.vetted !== "boolean") return undefined;
  return { name, vetted: raw.vetted };
};

const invalidReport = (name = "invalid"): HarnessLintReport => ({
  version: 1,
  subject: "agent-harness",
  harness: name,
  score: 0,
  grade: "F",
  findings: [
    {
      code: "descriptor.invalid",
      severity: "error",
      message: "The harness descriptor is missing required bounded fields.",
    },
  ],
});

export const parseHarnessDescriptor = (
  input: unknown,
): HarnessDescriptor | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Partial<Record<keyof HarnessDescriptor, unknown>>;
  const name = boundedText(raw.name);
  if (
    raw.version !== 1 ||
    !name ||
    (raw.approvalMode !== "ask" &&
      raw.approvalMode !== "manual" &&
      raw.approvalMode !== "yolo") ||
    !Array.isArray(raw.tools) ||
    raw.tools.length > MAX_ITEMS
  ) {
    return undefined;
  }
  const tools = raw.tools.map(parseTool);
  if (tools.some((tool) => tool === undefined)) return undefined;

  const mcpInput = raw.mcp ?? [];
  if (!Array.isArray(mcpInput) || mcpInput.length > MAX_ITEMS) return undefined;
  const mcp = mcpInput.map(parseMcp);
  if (mcp.some((server) => server === undefined)) return undefined;

  const bashDenyPatterns = raw.bashDenyPatterns;
  if (
    bashDenyPatterns !== undefined &&
    (typeof bashDenyPatterns !== "number" ||
      !Number.isInteger(bashDenyPatterns) ||
      bashDenyPatterns < 0)
  ) {
    return undefined;
  }

  const persistence = raw.persistence;
  if (
    persistence !== undefined &&
    (typeof persistence !== "object" ||
      persistence === null ||
      Array.isArray(persistence))
  ) {
    return undefined;
  }
  const parsedPersistence = persistence as HarnessDescriptor["persistence"];
  if (
    parsedPersistence &&
    [
      parsedPersistence.controlJournal,
      parsedPersistence.sensitiveTranscript,
      parsedPersistence.privatePermissions,
    ].some((value) => value !== undefined && typeof value !== "boolean")
  ) {
    return undefined;
  }

  const autonomy = raw.autonomy;
  if (
    autonomy !== undefined &&
    (typeof autonomy !== "object" ||
      autonomy === null ||
      Array.isArray(autonomy))
  ) {
    return undefined;
  }
  const parsedAutonomy = autonomy as HarnessDescriptor["autonomy"];
  if (
    parsedAutonomy &&
    ((parsedAutonomy.subagents !== undefined &&
      typeof parsedAutonomy.subagents !== "boolean") ||
      (parsedAutonomy.isolatedWorktrees !== undefined &&
        typeof parsedAutonomy.isolatedWorktrees !== "boolean") ||
      (parsedAutonomy.maxIterations !== undefined &&
        (!Number.isInteger(parsedAutonomy.maxIterations) ||
          parsedAutonomy.maxIterations <= 0)) ||
      (parsedAutonomy.maxCostUsd !== undefined &&
        (!Number.isFinite(parsedAutonomy.maxCostUsd) ||
          parsedAutonomy.maxCostUsd <= 0)))
  ) {
    return undefined;
  }

  const secretsInput = raw.secrets ?? [];
  if (!Array.isArray(secretsInput) || secretsInput.length > MAX_ITEMS) {
    return undefined;
  }
  const secrets: Array<NonNullable<HarnessDescriptor["secrets"]>[number]> = [];
  for (const item of secretsInput) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const secret = item as { source?: unknown; exposedToModel?: unknown };
    if (
      (secret.source !== "credential-store" &&
        secret.source !== "env" &&
        secret.source !== "file") ||
      typeof secret.exposedToModel !== "boolean"
    ) {
      return undefined;
    }
    secrets.push({
      source: secret.source,
      exposedToModel: secret.exposedToModel,
    });
  }

  return {
    version: 1,
    name,
    approvalMode: raw.approvalMode,
    ...(bashDenyPatterns !== undefined ? { bashDenyPatterns } : {}),
    tools: tools as HarnessToolDescriptor[],
    ...(mcp.length > 0 ? { mcp: mcp as HarnessMcpDescriptor[] } : {}),
    ...(parsedPersistence ? { persistence: parsedPersistence } : {}),
    ...(parsedAutonomy ? { autonomy: parsedAutonomy } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
  };
};

const add = (
  findings: HarnessLintFinding[],
  code: string,
  severity: HarnessLintFinding["severity"],
  message: string,
): void => {
  findings.push({ code, severity, message });
};

const grade = (score: number): HarnessLintReport["grade"] => {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
};

export const lintHarness = (input: unknown): HarnessLintReport => {
  const descriptor = parseHarnessDescriptor(input);
  if (!descriptor) return invalidReport();
  const findings: HarnessLintFinding[] = [];

  if (
    descriptor.approvalMode === "yolo" &&
    (descriptor.bashDenyPatterns ?? 0) === 0
  ) {
    add(
      findings,
      "approval.yolo-without-tripwire",
      "error",
      "YOLO mode needs a declared deny-only Bash tripwire.",
    );
  }

  for (const tool of descriptor.tools) {
    if (tool.effect === "exec" && tool.sandboxed !== true) {
      add(
        findings,
        "tool.exec-unsandboxed",
        "error",
        `Execution tool ${tool.name} is not declared sandboxed.`,
      );
    }
    if (tool.effect === "exec" && tool.network === "internet") {
      add(
        findings,
        "tool.exec-internet",
        "warning",
        `Execution tool ${tool.name} has direct internet access.`,
      );
    }
  }

  const seenTools = new Set<string>();
  for (const tool of descriptor.tools) {
    if (seenTools.has(tool.name)) {
      add(
        findings,
        "tool.duplicate-name",
        "warning",
        `Tool name ${tool.name} is declared more than once.`,
      );
    }
    seenTools.add(tool.name);
  }

  for (const server of descriptor.mcp ?? []) {
    if (!server.vetted) {
      add(
        findings,
        "mcp.unvetted",
        "error",
        `MCP server ${server.name} lacks a vet decision.`,
      );
    }
  }

  if (descriptor.persistence?.sensitiveTranscript) {
    if (!descriptor.persistence.privatePermissions) {
      add(
        findings,
        "persistence.transcript-permissions",
        "error",
        "Sensitive transcripts require private filesystem permissions.",
      );
    }
    if (!descriptor.persistence.controlJournal) {
      add(
        findings,
        "persistence.control-journal-missing",
        "warning",
        "Sensitive transcript state lacks a separate metadata-only control journal.",
      );
    }
  }

  if (descriptor.autonomy?.subagents) {
    if (!descriptor.autonomy.isolatedWorktrees) {
      add(
        findings,
        "autonomy.shared-worktree",
        "error",
        "Concurrent subagents require isolated worktrees.",
      );
    }
    if (
      descriptor.autonomy.maxIterations === undefined &&
      descriptor.autonomy.maxCostUsd === undefined
    ) {
      add(
        findings,
        "autonomy.unbounded",
        "warning",
        "Autonomous subagents need an iteration or cost bound.",
      );
    }
  }

  if (descriptor.secrets?.some((secret) => secret.exposedToModel)) {
    add(
      findings,
      "secrets.model-exposure",
      "error",
      "Credential values must not be exposed to the model context.",
    );
  }

  if (descriptor.tools.length === 0) {
    add(
      findings,
      "tools.empty",
      "info",
      "The harness declares no tool capabilities.",
    );
  }

  const deduction = findings.reduce((total, finding) => {
    if (finding.severity === "error") return total + 30;
    if (finding.severity === "warning") return total + 10;
    return total + 2;
  }, 0);
  const score = Math.max(0, 100 - deduction);
  return {
    version: 1,
    subject: "agent-harness",
    harness: descriptor.name,
    score,
    grade: grade(score),
    findings,
  };
};
