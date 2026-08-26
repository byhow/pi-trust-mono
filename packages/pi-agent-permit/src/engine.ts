import { basename, isAbsolute } from "node:path";
import { spawnPolicyEngine } from "./process.ts";
import type { PolicyDecision, PolicyEvaluation, PolicyInput } from "./types.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set([
  "__effect__",
  "__proto__",
  "constructor",
  "prototype",
]);

export type PolicyEngineConfig = {
  readonly binary: string;
  readonly bundleDir: string;
};

export type PolicyProcessResult = {
  readonly code: number;
  readonly killed: boolean;
  readonly stdout: string;
};

export type PolicyEngineExecutor = (
  config: PolicyEngineConfig,
  input: string,
) => Promise<PolicyProcessResult>;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
};

export const resolvePolicyEngineConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PolicyEngineConfig | undefined => {
  const binary = environment.PI_TRUST_ENGINE_BIN;
  if (
    !binary ||
    hasControlCharacter(binary) ||
    !isAbsolute(binary) ||
    basename(binary) !== "sy"
  ) {
    return undefined;
  }
  const bundleDir = environment.PI_TRUST_BUNDLE_DIR;
  if (!bundleDir || !isAbsolute(bundleDir) || hasControlCharacter(bundleDir)) {
    return undefined;
  }
  return { binary, bundleDir };
};

const boundedText = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  !hasControlCharacter(value)
    ? value
    : undefined;

const parsePolicyDecision = (raw: string): PolicyDecision | undefined => {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PolicyDecision>;
    if (
      value.effect !== "allow" &&
      value.effect !== "deny" &&
      value.effect !== "ask" &&
      value.effect !== "modify"
    ) {
      return undefined;
    }
    const reason = boundedText(value.reason, 2_048);
    const policy = value.policy;
    if (!reason || typeof policy !== "object" || policy === null)
      return undefined;
    const bundle = boundedText(policy.bundle, 256);
    const rule = boundedText(policy.rule, 256);
    const revision = boundedText(policy.revision, 128);
    if (!bundle || !rule || !revision) return undefined;

    let modified: Readonly<Record<string, unknown>> | undefined;
    if (value.modified !== undefined) {
      if (
        typeof value.modified !== "object" ||
        value.modified === null ||
        Array.isArray(value.modified) ||
        Object.keys(value.modified).length > 64 ||
        Object.keys(value.modified).some((key) => FORBIDDEN_KEYS.has(key)) ||
        Buffer.byteLength(JSON.stringify(value.modified)) > 32 * 1024
      ) {
        return undefined;
      }
      modified = value.modified;
    }
    if (value.effect === "modify" && !modified) return undefined;

    return {
      effect: value.effect,
      reason,
      ...(modified ? { modified } : {}),
      policy: { bundle, rule, revision },
    };
  } catch {
    return undefined;
  }
};

const validPolicyInput = (input: PolicyInput): boolean => {
  if (
    !boundedText(input.payload.tool, 128) ||
    !boundedText(input.context.cwd, 4_096) ||
    Object.keys(input.payload).length > 128 ||
    Object.keys(input.payload).some((key) => FORBIDDEN_KEYS.has(key))
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(JSON.stringify(input)) <= MAX_INPUT_BYTES;
  } catch {
    return false;
  }
};

export const evaluatePolicy = async (
  input: PolicyInput,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  execute: PolicyEngineExecutor = spawnPolicyEngine,
): Promise<PolicyEvaluation> => {
  const config = resolvePolicyEngineConfig(environment);
  if (!config || !validPolicyInput(input)) {
    return { ok: false, code: "policy-config-invalid" };
  }

  try {
    const result = await execute(config, JSON.stringify(input));
    if (result.killed || result.code === -1) {
      return { ok: false, code: "engine-unavailable" };
    }
    const decision = parsePolicyDecision(result.stdout);
    if (!decision) return { ok: false, code: "engine-invalid" };
    const validExit =
      decision.effect === "deny"
        ? result.code === 0 || result.code === 1
        : result.code === 0;
    if (!validExit) return { ok: false, code: "engine-invalid" };
    return { ok: true, decision };
  } catch {
    return { ok: false, code: "engine-unavailable" };
  }
};
