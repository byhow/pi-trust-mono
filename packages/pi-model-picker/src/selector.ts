import { basename, isAbsolute } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import selectionSchema from "../contracts/model-picker.selection.v1.schema.json" with {
  type: "json",
};
import type {
  ModelPickerRequest,
  ModelPickerResult,
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

export const MODEL_SELECTION_SCHEMA_SHA256 =
  "35a735b2efa9a6232d6de52f68f5b33b2292b407d592bfbd819185f78e46b68d";

export const resolveModelPickerBinary = (
  configured: string | undefined,
): string | undefined => {
  if (!configured) return undefined;
  for (const character of configured) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return undefined;
  }
  return isAbsolute(configured) && basename(configured) === "model-picker"
    ? configured
    : undefined;
};

export const buildModelPickerArguments = (
  request: ModelPickerRequest,
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

export const parseModelSelectionOutput = (raw: string): ModelPickerResult => {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) {
    return { ok: false, code: "selector-output-invalid" };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!Value.Check(selectionSchema as TSchema, value)) {
      return { ok: false, code: "selector-output-invalid" };
    }
    const selection = value as ModelSelectionEnvelope;
    if (
      selection.count !== selection.choices.length ||
      selection.choices.length > selection.request.limit
    ) {
      return { ok: false, code: "selector-output-invalid" };
    }
    return { ok: true, selection };
  } catch {
    return { ok: false, code: "selector-output-invalid" };
  }
};
