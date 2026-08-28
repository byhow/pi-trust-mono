import { type ModelPickerExecutor, spawnModelPicker } from "./process.ts";
import {
  buildModelPickerArguments,
  parseModelSelectionOutput,
  resolveModelPickerBinary,
} from "./selector.ts";
import type { ModelPickerRequest, ModelPickerResult } from "./types.ts";

export const runModelPicker = async (
  request: ModelPickerRequest,
  cwd: string,
  configuredBinary = process.env.PI_MODEL_PICKER_BIN,
  execute: ModelPickerExecutor = spawnModelPicker,
  signal?: AbortSignal,
): Promise<ModelPickerResult> => {
  const binary = resolveModelPickerBinary(configuredBinary);
  const args = buildModelPickerArguments(request);
  if (!binary || !args) return { ok: false, code: "selector-invalid" };

  try {
    const result = await execute(binary, args, cwd, signal);
    if (result.code !== 0 || result.killed) {
      return { ok: false, code: "selector-missing" };
    }
    return parseModelSelectionOutput(result.stdout);
  } catch {
    return { ok: false, code: "selector-missing" };
  }
};
