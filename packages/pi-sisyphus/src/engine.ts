import { basename, isAbsolute } from "node:path";
import { type SisyphusProcessResult, spawnSisyphus } from "./process.ts";
import type { TrustDecision, TrustEvaluation, TrustInput } from "./types.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set([
  "__effect__",
  "__proto__",
  "constructor",
  "prototype",
]);

export type SisyphusConfig = {
  readonly binary: string;
  readonly bundleDir: string;
  readonly bundleDigest: string;
  readonly decisionLog?: string;
};

export type TrustExecutor = (
  config: SisyphusConfig,
  input: string,
) => Promise<SisyphusProcessResult>;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
};

export const resolveSisyphusBinary = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const binary = environment.PI_SISYPHUS_BIN;
  return binary &&
    isAbsolute(binary) &&
    basename(binary) === "sy" &&
    !hasControlCharacter(binary)
    ? binary
    : undefined;
};

export const resolveSisyphusConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SisyphusConfig | undefined => {
  const binary = resolveSisyphusBinary(environment);
  const bundleDir = environment.PI_SISYPHUS_BUNDLE_DIR;
  const bundleDigest = environment.PI_SISYPHUS_BUNDLE_DIGEST;
  const decisionLog = environment.PI_SISYPHUS_DECISION_LOG;
  if (
    !binary ||
    !bundleDir ||
    !isAbsolute(bundleDir) ||
    hasControlCharacter(bundleDir) ||
    !bundleDigest ||
    !/^[a-f0-9]{64}$/u.test(bundleDigest) ||
    (decisionLog !== undefined &&
      (!isAbsolute(decisionLog) || hasControlCharacter(decisionLog)))
  ) {
    return undefined;
  }
  return {
    binary,
    bundleDir,
    bundleDigest,
    ...(decisionLog ? { decisionLog } : {}),
  };
};

const boundedText = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  !hasControlCharacter(value)
    ? value
    : undefined;

const parseDecision = (raw: string): TrustDecision | undefined => {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<TrustDecision>;
    if (
      value.version !== 1 ||
      (value.effect !== "allow" &&
        value.effect !== "deny" &&
        value.effect !== "ask" &&
        value.effect !== "modify")
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
    const requestId =
      value.requestId === undefined
        ? undefined
        : boundedText(value.requestId, 128);
    if (
      !bundle ||
      !rule ||
      !revision ||
      (value.requestId !== undefined && !requestId)
    ) {
      return undefined;
    }

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
      version: 1,
      ...(requestId ? { requestId } : {}),
      effect: value.effect,
      reason,
      ...(modified ? { modified } : {}),
      policy: { bundle, rule, revision },
    };
  } catch {
    return undefined;
  }
};

const serializeInput = (input: TrustInput): string | undefined => {
  if (
    input.version !== 1 ||
    !boundedText(input.requestId, 128) ||
    !boundedText(input.payload.tool, 128) ||
    !boundedText(input.context.cwd, 4_096) ||
    Object.keys(input.payload).length > 128 ||
    Object.keys(input.payload).some((key) => FORBIDDEN_KEYS.has(key))
  ) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(input);
    return Buffer.byteLength(serialized) <= MAX_INPUT_BYTES
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
};

const executeTrust: TrustExecutor = (config, input) =>
  spawnSisyphus(config.binary, ["evaluate", "-"], input, {
    TRUST_ENGINE_BUNDLE_DIR: config.bundleDir,
    TRUST_ENGINE_BUNDLE_DIGEST: config.bundleDigest,
    ...(config.decisionLog
      ? { TRUST_ENGINE_LOG_PATH: config.decisionLog }
      : {}),
  });

export const evaluateTrust = async (
  input: TrustInput,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  execute: TrustExecutor = executeTrust,
): Promise<TrustEvaluation> => {
  const config = resolveSisyphusConfig(environment);
  const serialized = serializeInput(input);
  if (!config || !serialized) {
    return { ok: false, code: "policy-config-invalid" };
  }

  try {
    const result = await execute(config, serialized);
    if (result.killed || result.code < 0) {
      return { ok: false, code: "engine-unavailable" };
    }
    const decision = parseDecision(result.stdout);
    const expectedExit = decision
      ? { allow: 0, deny: 1, ask: 2, modify: 3 }[decision.effect]
      : -1;
    if (
      !decision ||
      decision.requestId !== input.requestId ||
      result.code !== expectedExit
    ) {
      return { ok: false, code: "engine-invalid" };
    }
    return { ok: true, decision };
  } catch {
    return { ok: false, code: "engine-unavailable" };
  }
};
