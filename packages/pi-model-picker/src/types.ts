export type ModelPickerTask =
  | "agent"
  | "budget"
  | "coding"
  | "fast"
  | "long-context"
  | "review"
  | "vision";

export type ModelPickerRequest = {
  readonly task: ModelPickerTask;
  readonly filter?: string;
  readonly limit?: number;
  readonly weights?: {
    readonly speed?: number;
    readonly price?: number;
    readonly context?: number;
  };
};

export type ModelSelectionEnvelope = {
  readonly contract: "model-picker.selection";
  readonly version: 1;
  readonly source: "snapshot";
  readonly request: {
    readonly task: string | null;
    readonly agent:
      | "amp"
      | "opencode"
      | "claude-code"
      | "codex"
      | "cursor"
      | null;
    readonly filter: string | null;
    readonly limit: number;
    readonly weights: {
      readonly speed: number;
      readonly price: number;
      readonly context: number;
    };
  };
  readonly count: number;
  readonly choices: readonly {
    readonly id: string;
    readonly name: string;
    readonly score: number;
    readonly reasons: readonly string[];
    readonly contextWindow: number;
    readonly outputPerMillion: number | null;
    readonly bestThroughput: number | null;
  }[];
};

export type ModelPickerResult =
  | { readonly ok: true; readonly selection: ModelSelectionEnvelope }
  | {
      readonly ok: false;
      readonly code:
        | "selector-invalid"
        | "selector-missing"
        | "selector-output-invalid";
    };
