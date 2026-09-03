export {
  type CanaryActionDescriptor,
  canaryActionDescriptors,
} from "./canary-attestor.ts";
export {
  evaluateTrust,
  resolveSisyphusBinary,
  resolveSisyphusConfig,
  type SisyphusConfig,
  type TrustExecutor,
} from "./engine.ts";
export {
  createPiSisyphusExtension,
  createToolPolicyHandler,
} from "./extension.ts";
export { type McpVetExecutor, vetMcp } from "./mcp.ts";
export type {
  McpServerDescriptor,
  McpVetEvidence,
  McpVetResult,
  TrustDecision,
  TrustEvaluation,
  TrustInput,
} from "./types.ts";
