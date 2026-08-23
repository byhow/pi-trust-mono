import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@oh-my-pi/omptype/typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolApproval,
  ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";

/**
 * Structural subset of OMP 18's ToolDefinition.
 * Allows tools to be registered against either upstream Pi 0.84 or OMP 18
 * without pulling types that changed (e.g. TypeBox vs omptype).
 */
export interface HostToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  hidden?: boolean;
  defaultInactive?: boolean;
  loadMode?: ToolLoadMode;
  deferrable?: boolean;
  approval?: ToolApproval;
  strict?: boolean;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionCommandContext,
  ): Promise<AgentToolResult<TDetails>>;
}

/**
 * Common extension adapter context covering both OMP 18 and Pi 0.84.
 */
export interface HostCommandContext extends ExtensionCommandContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
  };
}
