export type HarnessToolDescriptor = {
  readonly name: string;
  readonly effect: "read" | "write" | "exec";
  readonly sandboxed?: boolean;
  readonly network?: "none" | "loopback" | "internet";
};

export type HarnessMcpDescriptor = {
  readonly name: string;
  readonly vetted: boolean;
};

export type HarnessDescriptor = {
  readonly version: 1;
  readonly name: string;
  readonly approvalMode: "ask" | "manual" | "yolo";
  readonly bashDenyPatterns?: number;
  readonly tools: readonly HarnessToolDescriptor[];
  readonly mcp?: readonly HarnessMcpDescriptor[];
  readonly persistence?: {
    readonly controlJournal?: boolean;
    readonly sensitiveTranscript?: boolean;
    readonly privatePermissions?: boolean;
  };
  readonly autonomy?: {
    readonly subagents?: boolean;
    readonly isolatedWorktrees?: boolean;
    readonly maxIterations?: number;
    readonly maxCostUsd?: number;
  };
  readonly secrets?: readonly {
    readonly source: "credential-store" | "env" | "file";
    readonly exposedToModel: boolean;
  }[];
};

export type HarnessLintFinding = {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
};

export type HarnessLintReport = {
  readonly version: 1;
  readonly subject: "agent-harness";
  readonly harness: string;
  readonly score: number;
  readonly grade: "A" | "B" | "C" | "D" | "F";
  readonly findings: readonly HarnessLintFinding[];
};
