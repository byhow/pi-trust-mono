import type { Static, TSchema } from "typebox";

export type HostContext = {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
};

export type HostExtensionAPI = {
  registerTool<TParams extends TSchema, TDetails>(tool: {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: TParams;
    readonly approval: "read" | "write" | "exec";
    readonly loadMode?: "essential" | "discoverable";
    execute(
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: HostContext,
    ): Promise<{
      readonly content: readonly {
        readonly type: "text";
        readonly text: string;
      }[];
      readonly details: TDetails;
      readonly isError?: boolean;
    }>;
  }): void;
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
};
