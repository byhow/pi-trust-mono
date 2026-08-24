import type { Static, TSchema } from "typebox";

export type HostExecResult = {
  readonly code: number;
  readonly killed: boolean;
  readonly stdout: string;
};

export type HostSessionManager = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
};

export type HostContext = {
  readonly cwd: string;
  readonly sessionManager: HostSessionManager;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
};

export type HostToolResult<TDetails> = {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: TDetails;
  readonly isError?: boolean;
};

export type HostToolDefinition<TParams extends TSchema, TDetails> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  readonly approval?: "read" | "write" | "exec";
  readonly loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: HostContext,
  ): Promise<HostToolResult<TDetails>>;
};

export type HostExtensionAPI = {
  registerTool<TParams extends TSchema, TDetails>(
    tool: HostToolDefinition<TParams, TDetails>,
  ): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (
        args: string,
        ctx: HostContext,
      ) => Promise<void> | void;
    },
  ): void;
  sendUserMessage(message: string): void;
  exec(
    command: string,
    args: string[],
    options: { readonly cwd: string },
  ): Promise<HostExecResult>;
};
