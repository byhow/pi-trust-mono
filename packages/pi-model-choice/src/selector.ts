import { basename, isAbsolute } from "node:path";
import type {
  ModelChoice,
  ModelChoiceRequest,
  ModelChoiceResult,
  ModelSelectionEnvelope,
} from "./types.ts";

const MAX_OUTPUT_BYTES = 256 * 1024;
const TASKS = new Set([
  "agent",
  "budget",
  "coding",
  "fast",
  "long-context",
  "review",
  "vision",
]);

export const resolveModelPickerBinary = (
  configured: string | undefined,
): string | undefined => {
  if (!configured) return "model-picker";
  for (const character of configured) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return undefined;
  }
  if (!isAbsolute(configured)) return undefined;
  const name = basename(configured);
  return name === "model-picker" || name === "mp" ? configured : undefined;
};

export const buildModelPickerArguments = (
  request: ModelChoiceRequest,
): readonly string[] | undefined => {
  if (!TASKS.has(request.task)) return undefined;
  const limit = request.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) return undefined;
  if (
    request.filter !== undefined &&
    (request.filter.length === 0 || request.filter.length > 256)
  ) {
    return undefined;
  }

  const args = [
    "pick",
    "--task",
    request.task,
    "--limit",
    String(limit),
    "--contract",
  ];
  if (request.filter) args.push("--filter", request.filter);
  if (request.weights) {
    const entries = Object.entries(request.weights);
    if (
      entries.length === 0 ||
      entries.some(
        ([, value]) =>
          value === undefined ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1,
      )
    ) {
      return undefined;
    }
    args.push(
      "--weights",
      entries.map(([key, value]) => `${key}=${value}`).join(","),
    );
  }
  return args;
};

const boundedText = (value: unknown, maxLength: number): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }
  return value;
};

const parseChoice = (value: unknown): ModelChoice | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<Record<keyof ModelChoice, unknown>>;
  const id = boundedText(raw.id, 256);
  const name = boundedText(raw.name, 256);
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.map((reason) => boundedText(reason, 256))
    : undefined;
  if (
    !id ||
    !name ||
    reasons === undefined ||
    reasons.length > 16 ||
    reasons.some((reason) => reason === undefined) ||
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score) ||
    typeof raw.contextWindow !== "number" ||
    !Number.isInteger(raw.contextWindow) ||
    raw.contextWindow <= 0 ||
    typeof raw.outputPerMillion !== "number" ||
    !Number.isFinite(raw.outputPerMillion) ||
    raw.outputPerMillion < 0 ||
    (raw.bestThroughput !== null &&
      (typeof raw.bestThroughput !== "number" ||
        !Number.isFinite(raw.bestThroughput) ||
        raw.bestThroughput < 0))
  ) {
    return undefined;
  }
  return {
    id,
    name,
    score: raw.score,
    reasons: reasons as string[],
    contextWindow: raw.contextWindow,
    outputPerMillion: raw.outputPerMillion,
    bestThroughput: raw.bestThroughput,
  };
};

export const parseModelSelectionOutput = (raw: string): ModelChoiceResult => {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) {
    return { ok: false, code: "selector-output-invalid" };
  }
  try {
    const value = JSON.parse(raw) as Partial<ModelSelectionEnvelope>;
    if (
      value.contract !== "model-picker.selection" ||
      value.version !== 1 ||
      value.source !== "snapshot" ||
      typeof value.request !== "object" ||
      value.request === null ||
      !Array.isArray(value.choices) ||
      value.choices.length > 10 ||
      value.count !== value.choices.length
    ) {
      return { ok: false, code: "selector-output-invalid" };
    }
    const choices = value.choices.map(parseChoice);
    if (choices.some((choice) => choice === undefined)) {
      return { ok: false, code: "selector-output-invalid" };
    }
    return {
      ok: true,
      selection: {
        contract: "model-picker.selection",
        version: 1,
        source: "snapshot",
        request: value.request,
        count: choices.length,
        choices: choices as ModelChoice[],
      },
    };
  } catch {
    return { ok: false, code: "selector-output-invalid" };
  }
};
